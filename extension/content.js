const sleep = ms => new Promise(r => setTimeout(r, ms));

function composer() {
  return document.querySelector('#prompt-textarea') ||
    document.querySelector('textarea[data-id="root"]') ||
    document.querySelector('main [contenteditable="true"]');
}

function assistantNodes() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
}

function turnOf(node) {
  return node?.closest('[data-testid^="conversation-turn-"]') ||
    node?.parentElement?.parentElement || node;
}

function copyButton(node) {
  const turn = turnOf(node);
  return turn?.querySelector('button[data-testid="copy-turn-action-button"]') ||
    turn?.querySelector('button[aria-label*="Copy"]') ||
    turn?.querySelector('button[aria-label*="复制"]');
}
function isGenerating() {
  return Boolean(
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label*="Stop"]') ||
    document.querySelector('button[aria-label*="停止"]')
  );
}

function conversationMissing() {
  const text = document.body?.innerText || '';
  return /Unable to load conversation|Conversation not found|对话不存在|无法加载对话/i.test(text);
}

async function waitFor(fn, timeoutMs = 20000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('Timed out waiting for ChatGPT page');
}

function rawTurnText(node) {
  return node?.innerText?.trim() || '';
}
async function copyFinalAnswer(node) {
  const button = copyButton(node);
  if (!button) return '';

  let before = null;
  try { before = await navigator.clipboard.readText(); } catch {}

  button.click();
  await sleep(180);

  let copied = '';
  for (let i = 0; i < 8; i++) {
    try { copied = (await navigator.clipboard.readText()).trim(); } catch {}
    if (copied) break;
    await sleep(100);
  }

  if (before !== null && copied && copied !== before) {
    try { await navigator.clipboard.writeText(before); } catch {}
  }
  return copied;
}

function cleanFallbackText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  const noisy = [
    'button', '[role="button"]', 'svg',
    '[data-testid*="source"]', '[data-testid*="citation"]',
    '[class*="source"]', '[class*="citation"]'
  ];
  for (const el of clone.querySelectorAll(noisy.join(','))) el.remove();

  const text = clone.innerText?.trim() || '';
  const lines = text.split('\n');
  const kept = lines.filter(line => {
    const s = line.trim();
    if (!s) return true;
    if (/^\+\d+$/.test(s)) return false;
    if (/^(Sources?|来源|References?)$/i.test(s)) return false;
    return true;
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function finalAnswer(node) {
  const copied = await copyFinalAnswer(node);
  if (copied && copied.length >= 20) return copied;
  return cleanFallbackText(node);
}
function setPrompt(el, text) {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ?
      HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, text);
  el.dispatchEvent(new InputEvent('input', {
    bubbles: true, inputType: 'insertText', data: text,
  }));
}
async function clickSend() {
  const button = await waitFor(() => {
    const found = document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="发送"]');
    return found && !found.disabled ? found : null;
  }, 8000);
  button.click();
}

async function runPrompt(prompt) {
  if (conversationMissing()) throw new Error('STALE_CONVERSATION');

  const before = assistantNodes().length;
  const input = await waitFor(composer, 20000);
  setPrompt(input, prompt);
  await sleep(300);
  await clickSend();

  await waitFor(() => assistantNodes().length > before, 60000, 400);
  let lastRaw = '';
  let stableSince = Date.now();
  const started = Date.now();
  while (Date.now() - started < 210000) {
    const nodes = assistantNodes();
    const node = nodes[nodes.length - 1];
    const raw = rawTurnText(node);

    if (raw !== lastRaw) {
      lastRaw = raw;
      stableSince = Date.now();
    }

    const stableMs = Date.now() - stableSince;
    if (raw && !isGenerating() && copyButton(node) && stableMs > 1800) {
      return await finalAnswer(node);
    }
    if (raw && !isGenerating() && stableMs > 10000) {
      return await finalAnswer(node);
    }
    await sleep(500);
  }
  throw new Error('ChatGPT generation timed out');
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RUN_PROMPT') return;

  runPrompt(msg.prompt)
    .then(answer => sendResponse({
      ok: true,
      answer,
      answerLength: answer.length,
      conversationUrl: location.href,
    }))
    .catch(err => sendResponse({
      ok: false,
      error: String(err?.message || err),
      conversationUrl: location.href,
    }));
  return true;
});
