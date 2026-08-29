import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  detectFileType,
  prepareInboundContent,
  RichContentError,
} from '../src/inbound-content.js';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

function channelWith(files, calls = []) {
  return {
    rawClient: {
      im: { v1: { messageResource: { get: async payload => {
        const { path } = payload;
        calls.push(payload);
        const file = files[path.file_key];
        return {
          headers: file.headers || {},
          getReadableStream: () => Readable.from(file.buffer),
        };
      } } } },
    },
  };
}

test('detects supported image types', () => {
  assert.deepEqual(detectFileType(PNG), { mime: 'image/png', extension: '.png' });
  assert.deepEqual(
    detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
    { mime: 'image/jpeg', extension: '.jpg' },
  );
});

test('preserves rich-text image order in one prompt and one attachment list', async () => {
  const channel = channelWith({ a: { buffer: PNG }, b: { buffer: PNG } });
  const result = await prepareInboundContent(channel, {
    messageId: 'om_test',
    content: '比较下面两张截图：\n![image](a)\n中间说明\n![image](b)',
    resources: [
      { type: 'image', fileKey: 'a' },
      { type: 'image', fileKey: 'b' },
    ],
  });

  assert.equal(result.prompt, '比较下面两张截图：\n[图片 1]\n中间说明\n[图片 2]');
  assert.deepEqual(result.attachments.map(item => item.name), [
    'feishu-image-1.png',
    'feishu-image-2.png',
  ]);
  assert.equal(result.attachments.length, 2);
});

test('adds a default instruction for an image-only message', async () => {
  const result = await prepareInboundContent(channelWith({ a: { buffer: PNG } }), {
    messageId: 'om_test',
    content: '![image](a)',
    resources: [{ type: 'image', fileKey: 'a' }],
  });
  assert.equal(result.prompt, '请分析这些图片。\n\n[图片 1]');
});

test('downloads a rich-text file through the message resource endpoint', async () => {
  const calls = [];
  const result = await prepareInboundContent(channelWith({
    file_a: {
      buffer: Buffer.from('%PDF-test'),
      headers: { 'content-disposition': 'attachment; filename="report.pdf"' },
    },
  }, calls), {
    messageId: 'om_file',
    content: '请概括：<file key="file_a"/>',
    resources: [{ type: 'file', fileKey: 'file_a' }],
  });

  assert.equal(result.prompt, '请概括：[附件 1：report.pdf]');
  assert.equal(result.attachments[0].mime, 'application/pdf');
  assert.deepEqual(calls, [{
    path: { message_id: 'om_file', file_key: 'file_a' },
    params: { type: 'file' },
  }]);
});

test('rejects attachment totals above the configured limit', async () => {
  await assert.rejects(
    prepareInboundContent(channelWith({ a: { buffer: PNG } }), {
      messageId: 'om_test',
      content: '![image](a)',
      resources: [{ type: 'image', fileKey: 'a' }],
    }, {
      maxAttachments: 10,
      maxAttachmentBytes: 1024,
      maxTotalBytes: 4,
    }),
    error => error instanceof RichContentError && /总大小/.test(error.message),
  );
});

test('downloads pending attachment refs from their original message ids', async () => {
  const calls = [];
  const result = await prepareInboundContent(
    channelWith({
      old_file: {
        buffer: Buffer.from('%PDF-old'),
        headers: { 'content-disposition': 'attachment; filename="old.pdf"' },
      },
    }, calls),
    {
      messageId: 'm_question',
      content: '请总结之前的附件',
      resources: [],
    },
    undefined,
    [{
      type: 'file',
      fileKey: 'old_file',
      fileName: 'old.pdf',
      sourceMessageId: 'm_attachment',
    }],
  );

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].name, 'old.pdf');
  assert.equal(calls[0].path.message_id, 'm_attachment');
});
