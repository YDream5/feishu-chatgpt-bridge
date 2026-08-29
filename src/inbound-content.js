import path from 'node:path';

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  maxAttachments: 10,
  maxAttachmentBytes: 20 * MIB,
  maxTotalBytes: 30 * MIB,
});

export class RichContentError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RichContentError';
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRichContentLimits(env = process.env) {
  return {
    maxAttachments: positiveInteger(
      env.RICH_TEXT_MAX_ATTACHMENTS,
      DEFAULT_LIMITS.maxAttachments,
    ),
    maxAttachmentBytes: positiveInteger(
      env.RICH_TEXT_MAX_ATTACHMENT_MB,
      DEFAULT_LIMITS.maxAttachmentBytes / MIB,
    ) * MIB,
    maxTotalBytes: positiveInteger(
      env.RICH_TEXT_MAX_TOTAL_MB,
      DEFAULT_LIMITS.maxTotalBytes / MIB,
    ) * MIB,
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function contentDispositionName(headers) {
  const disposition = headerValue(headers, 'content-disposition');
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch {}
  }
  return disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ||
    disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() || '';
}

function safeFileName(value) {
  const base = path.basename(String(value || '').replaceAll('\\', '/'));
  return base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
}

export function detectFileType(buffer) {
  if (buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' };
  }
  const prefix = buffer.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') {
    return { mime: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', extension: '.webp' };
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mime: 'application/pdf', extension: '.pdf' };
  }
  return null;
}

function extensionForMime(mime) {
  return new Map([
    ['text/plain', '.txt'],
    ['text/csv', '.csv'],
    ['application/json', '.json'],
    ['application/pdf', '.pdf'],
    ['application/zip', '.zip'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ]).get(mime) || '';
}

function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += next.length;
      if (size > maxBytes) {
        stream.destroy(new RichContentError(`单个附件不能超过 ${Math.floor(maxBytes / MIB)}MB。`));
        return;
      }
      chunks.push(next);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks, size)));
    stream.on('error', reject);
  });
}

async function downloadMessageResource(channel, messageId, resource, maxBytes) {
  let response;
  const sourceMessageId = resource.sourceMessageId || messageId;
  try {
    response = await channel.rawClient.im.v1.messageResource.get({
      path: {
        message_id: sourceMessageId,
        file_key: resource.fileKey,
      },
      params: { type: resource.type === 'image' ? 'image' : 'file' },
    });
  } catch (error) {
    throw new RichContentError(
      '无法读取飞书消息里的附件，请确认机器人已开通 im:message:readonly 权限并发布了新版本。',
      error,
    );
  }

  const declaredLength = Number(headerValue(response.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RichContentError(`单个附件不能超过 ${Math.floor(maxBytes / MIB)}MB。`);
  }
  return {
    buffer: await streamToBuffer(response.getReadableStream(), maxBytes),
    headers: response.headers,
  };
}

function replaceFirst(text, marker, replacement) {
  const index = text.indexOf(marker);
  if (index < 0) return text;
  return text.slice(0, index) + replacement + text.slice(index + marker.length);
}

function replaceResourceMarker(text, resource, label) {
  if (resource.type === 'image') {
    return replaceFirst(text, `![image](${resource.fileKey})`, label);
  }
  const escaped = resource.fileKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`<file\\b[^>]*\\bkey="${escaped}"[^>]*\\/?>`), label);
}

function hasInstructionText(prompt) {
  return prompt
    .replace(/\[(?:图片|附件)\s*\d+(?:：[^\]]+)?\]/g, '')
    .replace(/@[\p{L}\p{N}_-]+/gu, '')
    .trim().length > 0;
}

function makeAttachment(buffer, headers, resource, index) {
  const detected = detectFileType(buffer);
  const headerMime = headerValue(headers, 'content-type').split(';')[0].trim().toLowerCase();
  const mime = detected?.mime || headerMime || 'application/octet-stream';

  if (resource.type === 'image' && !['image/png', 'image/jpeg', 'image/gif'].includes(mime)) {
    throw new RichContentError('目前图片仅支持 PNG、JPEG 和非动态 GIF；请转换格式后重试。');
  }

  const suppliedName = resource.fileName || contentDispositionName(headers);
  const generatedExtension = detected?.extension || extensionForMime(mime);
  const generatedName = resource.type === 'image' ?
    `feishu-image-${index + 1}${generatedExtension}` :
    `feishu-attachment-${index + 1}${generatedExtension}`;
  const name = safeFileName(suppliedName) || generatedName;
  return {
    name,
    mime,
    size: buffer.length,
    dataBase64: buffer.toString('base64'),
  };
}

function mergedResources(message, extraResources = []) {
  const out = [];
  const seen = new Set();
  for (const resource of [...extraResources, ...(message.resources || [])]) {
    if (!resource?.fileKey || !['image', 'file'].includes(resource.type)) continue;
    const sourceMessageId = resource.sourceMessageId || message.messageId;
    const key = `${sourceMessageId}:${resource.fileKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...resource, sourceMessageId });
  }
  return out;
}

export async function prepareInboundContent(
  channel,
  message,
  limits = getRichContentLimits(),
  extraResources = [],
) {
  const resources = mergedResources(message, extraResources);
  if (resources.length > limits.maxAttachments) {
    throw new RichContentError(`一条消息最多支持 ${limits.maxAttachments} 个附件。`);
  }

  const attachments = [];
  let totalBytes = 0;
  let prompt = String(message.content || '');
  for (let index = 0; index < resources.length; index++) {
    const resource = resources[index];
    const downloaded = await downloadMessageResource(
      channel,
      message.messageId,
      resource,
      limits.maxAttachmentBytes,
    );
    totalBytes += downloaded.buffer.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new RichContentError(`一条消息的附件总大小不能超过 ${Math.floor(limits.maxTotalBytes / MIB)}MB。`);
    }

    const attachment = makeAttachment(downloaded.buffer, downloaded.headers, resource, index);
    attachments.push(attachment);
    const label = resource.type === 'image' ?
      `[图片 ${index + 1}]` : `[附件 ${index + 1}：${attachment.name}]`;
    prompt = replaceResourceMarker(prompt, resource, label);
  }

  prompt = prompt.trim();
  if (attachments.length && !hasInstructionText(prompt)) {
    const subject = attachments.every(item => item.mime.startsWith('image/')) ? '这些图片' : '这些附件';
    prompt = `请分析${subject}。${prompt ? `\n\n${prompt}` : ''}`;
  }
  if (!prompt) throw new RichContentError('消息中没有可发送给 ChatGPT 的文字或附件。');

  return { prompt, attachments };
}
