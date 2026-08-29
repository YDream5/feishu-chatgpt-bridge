import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.BRIDGE_PORT || 17331);
const pending = new Map();
let client = null;
let clientVersion = null;

const GENERATED_FILE_MAX_COUNT = 5;
const GENERATED_FILE_MAX_BYTES = 20 * 1024 * 1024;
const GENERATED_FILE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const GENERATED_FILE_NAME_RE = /\.(?:pdf|xlsx?|csv|docx|pptx|zip)$/i;

function normalizeGeneratedFiles(files) {
  if (!Array.isArray(files) || !files.length) return [];
  if (files.length > GENERATED_FILE_MAX_COUNT) {
    throw new Error(`Too many generated files: ${files.length}`);
  }
  let total = 0;
  return files.map((file, index) => {
    const name = String(file?.name || `generated-${index + 1}`).trim();
    const mime = String(file?.mime || 'application/octet-stream');
    const declared = Number(file?.size || 0);
    const dataBase64 = String(file?.dataBase64 || '');
    const localPath = String(file?.localPath || '');
    if (!GENERATED_FILE_NAME_RE.test(name)) {
      throw new Error(`Unsupported generated file type: ${name}`);
    }
    if (!dataBase64 && !localPath) {
      throw new Error(`Generated file data is missing: ${name}`);
    }
    const estimated = dataBase64 ? Math.floor(dataBase64.length * 3 / 4) : declared;
    if (declared > GENERATED_FILE_MAX_BYTES || estimated > GENERATED_FILE_MAX_BYTES + 3) {
      throw new Error(`Generated file is too large: ${name}`);
    }
    const size = declared || estimated;
    total += size;
    if (total > GENERATED_FILE_MAX_TOTAL_BYTES) {
      throw new Error('Generated files exceed total size limit');
    }
    return { name, mime, size, dataBase64, localPath };
  });
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => console.log(`[browser] ws://127.0.0.1:${PORT}`));
wss.on('connection', ws => {
  client = ws;
  console.log('[browser] Chrome extension connected');
  ws.on('close', () => {
    if (client === ws) {
      client = null;
      clientVersion = null;
    }
    console.log('[browser] Chrome extension disconnected');
  });
  ws.on('message', raw => handleMessage(ws, raw));
});

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.type === 'hello') {
    clientVersion = String(msg.version || '0.0.0');
    return console.log(`[browser] ${clientVersion} ready`);
  }
  if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
  if (!msg.id || !pending.has(msg.id)) return;
  const task = pending.get(msg.id);
  pending.delete(msg.id);
  clearTimeout(task.timer);
  if (msg.type === 'result') {
    try {
      const generatedFileDebug = String(msg.generatedFileDebug || '').slice(0, 6000);
      if (!Number(msg.generatedFileCandidates || 0) && generatedFileDebug) {
        console.warn(`[generated file debug] ${generatedFileDebug}`);
      }
      task.resolve({
        answer: String(msg.answer || ''),
        files: normalizeGeneratedFiles(msg.files),
        fileErrors: Array.isArray(msg.fileErrors) ? msg.fileErrors.map(String).slice(0, 5) : [],
        generatedFileCandidates: Number(msg.generatedFileCandidates || 0),
        generatedFileDebug,
      });
    } catch (error) {
      error.userMessage = '\u0043\u0068\u0061\u0074\u0047\u0050\u0054 \u5df2\u751f\u6210\u6587\u4ef6\uff0c\u4f46\u6587\u4ef6\u56de\u4f20\u6570\u636e\u5f02\u5e38\u6216\u8d85\u8fc7\u5927\u5c0f\u9650\u5236\u3002';
      task.reject(error);
    }
  } else {
    const error = new Error(msg.error || 'Browser task failed');
    if (/Generated file|generated files/i.test(error.message)) {
      error.userMessage = 'ChatGPT \u5df2\u751f\u6210\u6587\u4ef6\uff0c\u4f46\u6d4f\u89c8\u5668\u672a\u80fd\u628a\u6587\u4ef6\u5185\u5bb9\u8bfb\u53d6\u56de\u6765\u3002\u8bf7\u4fdd\u7559 ChatGPT \u9875\u9762\u5e76\u91cd\u8bd5\u3002';
    } else if (/attachment|file input|file preview/i.test(error.message)) {
      error.userMessage = '\u9644\u4ef6\u672a\u80fd\u5b8c\u6574\u4e0a\u4f20\u5230 ChatGPT\uff0c\u8bf7\u91cd\u65b0\u52a0\u8f7d\u6269\u5c55\u548c ChatGPT \u9875\u9762\u540e\u91cd\u8bd5\u3002';
    } else if (/prompt submission|worker composer|worker tab changed|new assistant response/i.test(error.message)) {
      error.userMessage = 'ChatGPT \u81ea\u52a8\u5316\u9875\u5b58\u5728\u672a\u53d1\u9001\u8349\u7a3f\u3001\u9875\u9762\u88ab\u624b\u52a8\u64cd\u4f5c\uff0c\u6216\u672c\u8f6e\u6d88\u606f\u672a\u771f\u6b63\u63d0\u4ea4\u3002\u8bf7\u6e05\u7a7a\u8f93\u5165\u6846\u548c\u6b8b\u7559\u9644\u4ef6\u540e\u91cd\u8bd5\u3002';
    } else if (/generation still active after timeout/i.test(error.message)) {
      error.userMessage = 'ChatGPT \u4ecd\u5728\u751f\u6210\u5185\u5bb9\uff0c\u5df2\u8d85\u8fc7\u5f53\u524d\u7b49\u5f85\u4e0a\u9650\u3002\u672c\u6b21\u4efb\u52a1\u672a\u88ab\u5f53\u4f5c\u6210\u529f\u8fd4\u56de\uff0c\u53ef\u7a0d\u540e\u91cd\u8bd5\u3002';
    } else if (/answer extraction timed out after generation appeared complete/i.test(error.message)) {
      error.userMessage = 'ChatGPT \u9875\u9762\u770b\u8d77\u6765\u5df2\u751f\u6210\u5b8c\u6210\uff0c\u4f46\u6269\u5c55\u672a\u80fd\u7a33\u5b9a\u8bfb\u53d6\u6700\u7ec8\u7b54\u6848\uff08DOM \u5b8c\u6210\u68c0\u6d4b\u5931\u8d25\uff09\u3002\u8bf7\u5237\u65b0 ChatGPT \u9875\u9762\u540e\u91cd\u8bd5\u3002';
    } else if (/browser response timed out/i.test(error.message)) {
      error.userMessage = '\u6d4f\u89c8\u5668\u81ea\u52a8\u5316\u4efb\u52a1\u8d85\u8fc7\u603b\u7b49\u5f85\u4e0a\u9650\uff0c\u672a\u6536\u5230\u6700\u7ec8\u7ed3\u679c\u3002\u8bf7\u68c0\u67e5 ChatGPT \u9875\u9762\u72b6\u6001\u540e\u91cd\u8bd5\u3002';
    }
    task.reject(error);
  }
}
function waitForClient(timeoutMs = 15000) {
  if (client?.readyState === 1) return Promise.resolve(client);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (client?.readyState === 1) {
        clearInterval(timer);
        resolve(client);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Chrome extension is not connected'));
      }
    }, 250);
  });
}

export async function askBrowser(prompt, sessionKey, attachments = []) {
  const ws = await waitForClient();
  const [major = 0, minor = 0, patch = 0] = String(clientVersion || '0.0.0')
    .split('.').map(part => Number(part) || 0);
  const supportsBoundTurns =
    major > 0 || minor > 3 || (minor === 3 && patch >= 19);
  if (!supportsBoundTurns) {
    const error = new Error('Chrome extension 0.3.19 or newer is required for in-memory button-download relay');
    error.userMessage = '\u672c\u673a Chrome \u6269\u5c55\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u65b0\u52a0\u8f7d 0.3.19 \u6269\u5c55\u5e76\u5237\u65b0 ChatGPT \u9875\u9762\u540e\u91cd\u8bd5\u3002';
    throw error;
  }
  const supportsReliableAttachments =
    major > 0 || minor > 3 || (minor === 3 && patch >= 3);
  if (attachments.length && !supportsReliableAttachments) {
    const error = new Error('Chrome extension 0.3.3 or newer is required for reliable attachments');
    error.userMessage = '\u672c\u673a Chrome \u6269\u5c55\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u65b0\u52a0\u8f7d\u6269\u5c55\u5e76\u5237\u65b0 ChatGPT \u9875\u9762\u540e\u91cd\u8bd5\u3002';
    throw error;
  }
  if (attachments.length) {
    const summary = attachments.map((item, index) =>
      `${index + 1}:${item.name || 'attachment'} ${item.mime || 'unknown'} ${item.size || 0}B`
    ).join(', ');
    console.log(`[browser attachments] ${summary}`);
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('ChatGPT browser response timed out'));
    }, 300_000);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({
        type: 'ask', id, prompt, sessionKey, attachments,
      }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}
