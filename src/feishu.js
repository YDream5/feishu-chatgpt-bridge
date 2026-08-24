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
      requireMention: true,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
    },
    outbound: {
      textChunkLimit: 3000,
      markdownConverter: 'builtin',
    },
    handshakeTimeoutMs: 20000,
  });
}
