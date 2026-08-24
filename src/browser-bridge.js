import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.BRIDGE_PORT || 17331);
const pending = new Map();
let client = null;

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => console.log(`[browser] ws://127.0.0.1:${PORT}`));
wss.on('connection', ws => {
  client = ws;
  console.log('[browser] Chrome extension connected');
  ws.on('close', () => {
    if (client === ws) client = null;
    console.log('[browser] Chrome extension disconnected');
  });
  ws.on('message', raw => handleMessage(ws, raw));
});

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.type === 'hello') return console.log(`[browser] ${msg.version || 'extension'} ready`);
  if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
  if (!msg.id || !pending.has(msg.id)) return;
  const task = pending.get(msg.id);
  pending.delete(msg.id);
  clearTimeout(task.timer);
  if (msg.type === 'result') task.resolve(msg.answer);
  else task.reject(new Error(msg.error || 'Browser task failed'));
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

export async function askBrowser(prompt, sessionKey) {
  const ws = await waitForClient();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('ChatGPT browser response timed out'));
    }, 240_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'ask', id, prompt, sessionKey }));
  });
}
