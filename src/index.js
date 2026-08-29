import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { askChatGPT } from './chatgpt.js';
import { createFeishuChannel } from './feishu.js';
import {
  getRichContentLimits,
  prepareInboundContent,
  RichContentError,
} from './inbound-content.js';
import {
  PendingAttachmentStore,
  pendingAttachmentKey,
} from './pending-attachments.js';
import { registerRuntime } from './runtime.js';

const runtime = registerRuntime();
const channel = createFeishuChannel();
const richLimits = getRichContentLimits();
const pendingAttachments = new PendingAttachmentStore({
  maxAttachments: richLimits.maxAttachments,
});
const messageTails = new Map();

const GENERATED_FILE_MAX_COUNT = 5;
const GENERATED_FILE_MAX_BYTES = 20 * 1024 * 1024;
const GENERATED_FILE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

function looksLikeHtml(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

function validateGeneratedFileBuffer(fileName, buffer) {
  if (looksLikeHtml(buffer)) return false;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (/\.(xlsx|docx|pptx|zip)$/.test(lower)) return buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (lower.endsWith('.xls')) {
    const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return magic.every((value, index) => buffer[index] === value);
  }
  return true;
}

async function decodeGeneratedFiles(files) {
  if (!Array.isArray(files) || !files.length) return [];
  if (files.length > GENERATED_FILE_MAX_COUNT) {
    throw new Error(`Too many generated files: ${files.length}`);
  }
  let total = 0;
  const decoded = [];
  const acquiredTempPaths = new Set();
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const rawName = String(file?.name || `generated-${index + 1}`).trim();
      const fileName = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
      const dataBase64 = String(file?.dataBase64 || '');
      const localPath = String(file?.localPath || '');
      let buffer;
      let tempPath = '';

      if (dataBase64) {
        buffer = Buffer.from(dataBase64, 'base64');
      } else if (localPath) {
        const resolved = path.resolve(localPath);
        const marker = `${path.sep}feishu-chatgpt-tmp${path.sep}`.toLowerCase();
        if (!resolved.toLowerCase().includes(marker)) {
          throw new Error(`Generated temp file path is outside the managed directory: ${fileName}`);
        }
        buffer = await readFile(resolved);
        tempPath = resolved;
        acquiredTempPaths.add(resolved);
      } else {
        throw new Error(`Generated file data is missing: ${fileName}`);
      }

      if (!buffer.length || buffer.length > GENERATED_FILE_MAX_BYTES) {
        throw new Error(`Generated file is invalid or too large: ${fileName}`);
      }
      if (!validateGeneratedFileBuffer(fileName, buffer)) {
        throw new Error(`Generated file content does not match its file type: ${fileName}`);
      }
      total += buffer.length;
      if (total > GENERATED_FILE_MAX_TOTAL_BYTES) {
        throw new Error('Generated files exceed total size limit');
      }
      decoded.push({
        fileName,
        buffer,
        size: buffer.length,
        mime: String(file?.mime || 'application/octet-stream'),
        tempPath,
      });
    }
    return decoded;
  } catch (error) {
    for (const tempPath of acquiredTempPaths) {
      await unlink(tempPath).catch(() => {});
    }
    throw error;
  }
}

async function sendGeneratedFiles(msg, files) {
  let decoded;
  const errors = [];
  try {
    decoded = await decodeGeneratedFiles(files);
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[generated file decode error] ${message}`);
    return { sent: 0, errors: [message] };
  }
  let sent = 0;
  for (const file of decoded) {
    try {
      await channel.send(
        msg.chatId,
        { file: { source: file.buffer, fileName: file.fileName } },
        { replyTo: msg.messageId },
      );
      sent++;
      console.log(`[generated file] ${file.fileName} ${file.size}B -> Feishu`);
    } catch (error) {
      console.error(`[generated file error] ${file.fileName}`, error);
      errors.push(`${file.fileName}: Feishu upload failed`);
    } finally {
      if (file.tempPath) {
        await unlink(file.tempPath).catch(error =>
          console.warn(`[generated file cleanup] failed to delete ${file.tempPath}: ${error.message}`)
        );
      }
    }
  }
  return { sent, errors };
}

console.log(`[runtime] PID ${runtime.pid}`);
console.log('[feishu] official Node SDK + WebSocket');
console.log('[pending] attachment metadata TTL=5m, storage=memory-only');

function hasAttachments(msg) {
  return (msg.resources || []).some(resource =>
    resource?.fileKey && ['image', 'file'].includes(resource.type)
  );
}
function commandOf(msg) {
  return String(msg.content || '').trim().toLowerCase();
}

function enqueueBySender(msg, task) {
  const key = pendingAttachmentKey(msg);
  const previous = messageTails.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  messageTails.set(key, next);
  return next.finally(() => {
    if (messageTails.get(key) === next) messageTails.delete(key);
  });
}

async function sendTextReply(msg, text) {
  await channel.send(
    msg.chatId,
    { text },
    { replyTo: msg.messageId },
  );
}

async function handleMessage(msg) {
  const isGroup = msg.chatType === 'group';

  if (isGroup && !msg.mentionedBot) {
    if (!hasAttachments(msg)) return;
    const state = pendingAttachments.add(msg);
    console.log(
      `[pending] ${pendingAttachmentKey(msg)} +${state.added}, ` +
      `total=${state.total}, overflow=${state.overflow || 0}`,
    );
    return;
  }
  const command = commandOf(msg);
  if (command === '/clear' || command === '清除附件' || command === '清空附件') {
    const cleared = pendingAttachments.clear(msg);
    await sendTextReply(
      msg,
      cleared ? '✅ 已清空你当前待处理的附件。' : '✅ 当前没有待处理附件。',
    );
    return;
  }

  if (command === '/new') pendingAttachments.clear(msg);

  const pending = isGroup ? pendingAttachments.info(msg) : { refs: [], overflow: 0 };
  if (pending.overflow > 0) {
    throw new RichContentError(
      `待处理附件超过上限 ${richLimits.maxAttachments} 个，请先 @机器人 /clear 后重新发送。`,
    );
  }

  const input = await prepareInboundContent(
    channel,
    msg,
    richLimits,
    pending.refs,
  );
  console.log(
    `[recv] ${msg.messageId} ${msg.senderId}: ` +
    `${input.prompt.length} chars, ${input.attachments.length} attachment(s)` +
    (pending.refs.length ? ` (${pending.refs.length} pending)` : ''),
  );
  const result = await askChatGPT(
    input.prompt,
    msg.chatId || msg.senderId,
    input.attachments,
  );
  const answer = typeof result === 'string' ? result : String(result?.answer || '');
  const generatedFiles = typeof result === 'string' ? [] : (result?.files || []);
  const generatedFileErrors = typeof result === 'string' ? [] : (result?.fileErrors || []);
  const generatedFileCandidates = typeof result === 'string' ? 0 : Number(result?.generatedFileCandidates || 0);

  let sent = null;
  if (answer) {
    sent = await channel.send(
      msg.chatId,
      { markdown: answer },
      { replyTo: msg.messageId },
    );
  }
  const generatedSend = await sendGeneratedFiles(msg, generatedFiles);
  const allGeneratedFileErrors = [...generatedFileErrors, ...generatedSend.errors];
  if (allGeneratedFileErrors.length) {
    console.warn(`[generated file errors] ${allGeneratedFileErrors.join(' | ')}`);
  }
  if (allGeneratedFileErrors.length) {
    await sendTextReply(
      msg,
      `\u26a0\ufe0f \u6709 ${allGeneratedFileErrors.length} \u4e2a ChatGPT \u751f\u6210\u6587\u4ef6\u672a\u80fd\u56de\u4f20\uff1a` +
      allGeneratedFileErrors.map(item => `\n- ${item}`).join(''),
    );
  }

  if (pending.refs.length) {
    pendingAttachments.clear(msg);
    console.log(`[pending] consumed ${pending.refs.length} attachment(s)`);
  }

  const parts = sent ? 1 + (sent.chunkIds?.length || 0) : 0;
  console.log(
    `[answer] ${answer.length} chars -> ${parts} Feishu message(s), ` +
    `${generatedSend.sent}/${generatedFileCandidates} generated file(s), ` +
    `${allGeneratedFileErrors.length} file error(s)`,
  );
  console.log(`[done] ${msg.messageId}`);
}

channel.on('message', msg => enqueueBySender(msg, async () => {
  try {
    await handleMessage(msg);
  } catch (err) {
    console.error('[task error]', err);
    try {
      const safeMessage = err instanceof RichContentError ? err.message : err?.userMessage;
      const errorText = safeMessage ?
        `⚠️ ${safeMessage}` : '⚠️ ChatGPT 暂时不可用，请稍后重试。';
      await sendTextReply(msg, errorText);
    } catch (replyErr) {
      console.error('[error reply failed]', replyErr);
    }
  }
}));
channel.on('reject', evt => {
  console.log(`[feishu reject] ${evt.reason || 'policy'}`);
});
channel.on('reconnecting', () => console.warn('[feishu] reconnecting...'));
channel.on('reconnected', () => console.log('[feishu] reconnected'));

const sweepTimer = setInterval(() => {
  const removed = pendingAttachments.sweep();
  if (removed) console.log(`[pending] expired ${removed} batch(es)`);
}, 60_000);
sweepTimer.unref?.();

await channel.connect();
console.log('[feishu] websocket connected');
console.log('Feishu ChatGPT bridge started. Waiting for messages...');
