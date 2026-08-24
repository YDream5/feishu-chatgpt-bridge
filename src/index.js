import { askChatGPT } from './chatgpt.js';
import { createFeishuChannel } from './feishu.js';
import { registerRuntime } from './runtime.js';

const runtime = registerRuntime();
const channel = createFeishuChannel();

console.log(`[runtime] PID ${runtime.pid}`);
console.log('[feishu] official Node SDK + WebSocket');

channel.on('message', async msg => {
  console.log(`[recv] ${msg.messageId} ${msg.senderId}: ${msg.content}`);
  try {
    const answer = await askChatGPT(msg.content, msg.chatId || msg.senderId);
    const sent = await channel.send(
      msg.chatId,
      { markdown: answer },
      { replyTo: msg.messageId },
    );
    const parts = 1 + (sent.chunkIds?.length || 0);
    console.log(`[answer] ${answer.length} chars -> ${parts} Feishu message(s)`);
    console.log(`[done] ${msg.messageId}`);
  } catch (err) {
    console.error('[task error]', err);
    try {
      await channel.send(msg.chatId, { text: '⚠️ ChatGPT 暂时不可用，请稍后重试。' }, { replyTo: msg.messageId });
    } catch (replyErr) {
      console.error('[error reply failed]', replyErr);
    }
  }
});

channel.on('reject', evt => {
  console.log(`[feishu reject] ${evt.reason || 'policy'}`);
});
channel.on('reconnecting', () => console.warn('[feishu] reconnecting...'));
channel.on('reconnected', () => console.log('[feishu] reconnected'));

await channel.connect();
console.log('[feishu] websocket connected');
console.log('Feishu ChatGPT bridge started. Waiting for messages...');
