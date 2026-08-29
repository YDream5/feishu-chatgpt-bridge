import * as Lark from '@larksuiteoapi/node-sdk';
import { getFeishuConfig } from './config.js';

export function createFeishuChannel() {
  const { appId, appSecret } = getFeishuConfig();
  return Lark.createLarkChannel({
    appId,
    appSecret,
    transport: 'websocket',
    source: 'feishu-chatgpt',
    loggerLevel: Lark.LoggerLevel.info,
    policy: {
      dmMode: 'open',
      // Group messages must reach our handler so file-only messages can be
      // cached before the user mentions the bot. index.js filters them.
      requireMention: false,
      respondToMentionAll: false,
    },
    safety: {
      // The SDK queue batches by chatId only; our attachment batches are
      // isolated by chatId + senderId, so avoid cross-user merging here.
      chatQueue: { enabled: false },
    },
    outbound: {
      textChunkLimit: 3000,
      markdownConverter: 'builtin',
    },
    handshakeTimeoutMs: 20000,
  });
}
