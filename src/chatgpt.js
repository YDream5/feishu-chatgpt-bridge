import { askBrowser } from './browser-bridge.js';

export async function askChatGPT(text, sessionKey) {
  const prompt = String(text ?? '').trim();
  if (!prompt) throw new Error('Empty message');
  return askBrowser(prompt, sessionKey || 'default');
}
