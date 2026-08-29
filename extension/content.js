const sleep = ms => new Promise(r => setTimeout(r, ms));

function composer() {
  return document.querySelector('#prompt-textarea') ||
    document.querySelector('textarea[data-id="root"]') ||
    document.querySelector('main [contenteditable="true"]');
}

function assistantNodes() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
}

function userNodes() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

function turnOf(node) {
  return node?.closest('[data-testid^="conversation-turn-"]') ||
    node?.parentElement?.parentElement || node;
}

function isGenerating() {
  return Boolean(
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[data-testid*="stop"]') ||
    document.querySelector('button[aria-label*="Stop"]') ||
    document.querySelector('button[aria-label*="Cancel generation"]') ||
    document.querySelector('button[aria-label*="停止"]') ||
    document.querySelector('button[aria-label*="取消生成"]')
  );
}

function conversationMissing() {
  const text = document.body?.innerText || '';
  return /Unable to load conversation|Conversation not found|对话不存在|无法加载对话/i.test(text);
}

async function waitFor(fn, timeoutMs = 20000, interval = 250, errorMessage = 'Timed out waiting for ChatGPT page') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(errorMessage);
}

function rawTurnText(node) {
  return node?.innerText?.trim() || '';
}

function composerText(node = composer()) {
  if (!node) return '';
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    return String(node.value || '').trim();
  }
  return String(node.innerText || node.textContent || '').trim();
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function userTurnMatchesPrompt(node, prompt) {
  const expected = normalizeText(prompt);
  const actual = normalizeText(rawTurnText(node));
  if (!expected || !actual) return false;
  const probe = expected.slice(0, Math.min(120, expected.length));
  return actual.includes(probe);
}

function nodeFollows(reference, node) {
  if (!reference?.isConnected || !node?.isConnected) return false;
  return Boolean(reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function extractDomAnswerText(node) {
  if (!node) return '';
  const content = node.querySelector?.('.markdown') || node;
  const clone = content.cloneNode(true);
  const noisy = [
    'button', '[role="button"]', 'svg',
    '[data-testid*="source"]', '[data-testid*="citation"]',
    '[class*="source"]', '[class*="citation"]'
  ];
  for (const el of clone.querySelectorAll(noisy.join(','))) el.remove();

  const text = clone.innerText?.trim() || clone.textContent?.trim() || '';
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


const GENERATED_FILE_MAX_COUNT = 5;
const GENERATED_FILE_MAX_BYTES = 20 * 1024 * 1024;
const GENERATED_FILE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const GENERATED_FILE_NAME_RE = /([^\n<>:"/\\|?*]{1,180}\.(?:pdf|xlsx?|csv|docx|pptx|zip))(?:\b|$)/i;

function normalizeGeneratedFileName(name) {
  let value = String(name || '').normalize('NFKC').trim();
  value = value.replace(/\p{Cf}/gu, '');
  value = value.replace(/^(?:(?:download(?:ed)?|generated|file|attachment|analy(?:zed|sed)|analysis)\s*[:\uFF1A-]?\s*)+/i, '');
  value = value.replace(/^(?:(?:\u4e0b\u8f7d|\u5df2\u751f\u6210|\u751f\u6210|\u6587\u4ef6|\u9644\u4ef6)\s*[:\uFF1A-]?\s*)+/i, '');
  return value.replace(/\s+/g, ' ').trim();
}

function generatedFileNameKey(name) {
  return normalizeGeneratedFileName(name).toLowerCase();
}

function generatedFileNameFromNode(node) {
  if (!node) return '';
  const probes = [
    node.getAttribute?.('download'),
    node.getAttribute?.('title'),
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('data-filename'),
    node.getAttribute?.('data-file-name'),
    node.textContent,
  ];
  for (const probe of probes) {
    const match = String(probe || '').match(GENERATED_FILE_NAME_RE);
    if (match) return normalizeGeneratedFileName(match[1]);
  }
  return '';
}

function urlFromCandidateNode(node) {
  if (!node) return '';
  const attrNames = [
    'href', 'data-href', 'data-url', 'data-download-url',
    'data-file-url', 'data-file-download-url',
  ];
  for (const attr of attrNames) {
    const value = node.getAttribute?.(attr);
    if (value) {
      try { return new URL(value, location.href).href; } catch {}
    }
  }
  const descendant = node.querySelector?.('a[href]');
  if (descendant?.href) return descendant.href;
  const closest = node.closest?.('a[href]');
  if (closest?.href) return closest.href;

  let parent = node.parentElement;
  for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
    for (const attr of attrNames) {
      const value = parent.getAttribute?.(attr);
      if (value) {
        try { return new URL(value, location.href).href; } catch {}
      }
    }
    const link = parent.querySelector?.('a[href]');
    if (link?.href) return link.href;
  }
  return '';
}

function generatedFileCandidates(node) {
  const turn = turnOf(node);
  if (!turn) return [];
  const seen = new Set();
  const seenNames = new Set();
  const result = [];
  const selectors = [
    'a[href]', 'button', '[role="button"]', '[data-testid]',
    '[download]', '[data-href]', '[data-url]', '[data-download-url]',
    '[data-file-url]', '[data-file-download-url]',
  ];
  const nodes = [turn, ...turn.querySelectorAll(selectors.join(','))];
  const hasDownloadControl = [...turn.querySelectorAll('button,[role="button"]')]
    .some(item => /download file|下载文件|下载/i.test(
      `${item.getAttribute?.('aria-label') || ''} ${item.innerText || item.textContent || ''}`,
    ));

  for (const item of nodes) {
    let name = generatedFileNameFromNode(item);
    if (!name) {
      let parent = item.parentElement;
      for (let i = 0; parent && i < 3 && !name; i++, parent = parent.parentElement) {
        const match = String(parent.innerText || '').slice(0, 800).match(GENERATED_FILE_NAME_RE);
        if (match) name = normalizeGeneratedFileName(match[1]);
      }
    }
    if (!name) continue;
    const nameKey = generatedFileNameKey(name);
    if (!nameKey || seenNames.has(nameKey)) continue;
    const url = urlFromCandidateNode(item);
    const key = url ? `url:${url}` : `download:${nameKey}`;
    if (seen.has(key)) continue;
    if (!url && !hasDownloadControl) continue;
    seen.add(key);
    seenNames.add(nameKey);
    result.push({ name, url, downloadFallback: !url });
    if (result.length >= GENERATED_FILE_MAX_COUNT) break;
  }
  return result;
}

function generatedFileDomSummary(node) {
  const turn = turnOf(node);
  if (!turn) return '';
  const rows = [];
  const nodes = [
    ...turn.querySelectorAll('a,button,[role="button"],[data-testid],[download],[data-href],[data-url],[data-file-url]'),
  ];
  for (const item of nodes) {
    const text = String(item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim();
    const attrs = {};
    for (const key of [
      'href', 'download', 'title', 'aria-label', 'role', 'data-testid',
      'data-href', 'data-url', 'data-download-url', 'data-file-url',
      'data-file-download-url', 'data-filename', 'data-file-name',
    ]) {
      const value = item.getAttribute?.(key);
      if (value) attrs[key] = String(value).slice(0, 240);
    }
    const looksRelevant = GENERATED_FILE_NAME_RE.test(text) ||
      Object.values(attrs).some(value => GENERATED_FILE_NAME_RE.test(value)) ||
      /file|download|artifact/i.test(JSON.stringify(attrs));
    if (!looksRelevant) continue;
    rows.push(`${item.tagName?.toLowerCase() || 'node'} text=${JSON.stringify(text.slice(0, 240))} attrs=${JSON.stringify(attrs)}`);
    if (rows.length >= 20) break;
  }
  return rows.join(' | ').slice(0, 6000);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return btoa(chunks.join(''));
}

function fileNameFromDisposition(value, fallback) {
  const text = String(value || '');
  const utf8 = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].replace(/["']/g, '')); } catch {}
  }
  const plain = text.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1]?.trim() || fallback;
}

async function captureGeneratedFile(candidate) {
  const captured = await chrome.runtime.sendMessage({
    type: 'CAPTURE_GENERATED_DOWNLOAD',
    fileName: candidate.name,
    maxBytes: GENERATED_FILE_MAX_BYTES,
  }).catch(() => null);
  if (!captured?.ok) {
    throw new Error(
      `Generated file download could not be captured: ${candidate.name}; ` +
      `${captured?.error || 'download capture failed'}`,
    );
  }
  return captured.file;
}

async function fetchGeneratedFile(candidate) {
  const url = String(candidate.url || '');
  const directHttp = /^https?:\/\//i.test(url);
  const directBlob = /^blob:/i.test(url);
  if (!url || candidate.downloadFallback || (!directHttp && !directBlob)) {
    return await captureGeneratedFile(candidate);
  }

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    response = await fetch(url, { credentials: 'include', signal: controller.signal });
  } catch {} finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    if (directHttp) {
      const fetched = await chrome.runtime.sendMessage({
        type: 'FETCH_GENERATED_FILE',
        url,
        fileName: candidate.name,
        maxBytes: GENERATED_FILE_MAX_BYTES,
      }).catch(() => null);
      if (fetched?.ok) return fetched.file;
    }
    return await captureGeneratedFile(candidate);
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > GENERATED_FILE_MAX_BYTES) {
    throw new Error(`Generated file is too large: ${candidate.name} (${declared} bytes)`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > GENERATED_FILE_MAX_BYTES) {
    throw new Error(`Generated file is too large: ${candidate.name} (${buffer.byteLength} bytes)`);
  }
  return {
    name: fileNameFromDisposition(response.headers.get('content-disposition'), candidate.name),
    mime: response.headers.get('content-type') || 'application/octet-stream',
    size: buffer.byteLength,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

async function collectGeneratedFiles(node) {
  const candidates = generatedFileCandidates(node);
  const files = [];
  const failures = [];
  const successfulNames = new Set();
  const debug = candidates.length ? '' : generatedFileDomSummary(node);
  let total = 0;
  for (const candidate of candidates) {
    const candidateKey = generatedFileNameKey(candidate.name);
    if (candidateKey && successfulNames.has(candidateKey)) continue;
    try {
      const file = await fetchGeneratedFile(candidate);
      const fileKey = generatedFileNameKey(file?.name || candidate.name);
      total += Number(file.size || 0);
      if (total > GENERATED_FILE_MAX_TOTAL_BYTES) {
        failures.push({ key: candidateKey, message: `${candidate.name}: generated files exceed total size limit` });
        break;
      }
      files.push(file);
      if (candidateKey) successfulNames.add(candidateKey);
      if (fileKey) successfulNames.add(fileKey);
    } catch (error) {
      failures.push({
        key: candidateKey,
        message: `${candidate.name}: ${String(error?.message || error)}`,
      });
    }
  }
  const errors = failures
    .filter(item => !item.key || !successfulNames.has(item.key))
    .map(item => item.message);
  return { files, errors, candidates: candidates.length, debug };
}

function turnStreaming(node) {
  const turn = turnOf(node);
  if (!turn) return false;
  const selectors = [
    '[data-message-streaming="true"]',
    '[data-is-streaming="true"]',
    '[data-state="streaming"]',
    '[data-testid="streaming-indicator"]',
  ];
  return Boolean(turn.querySelector(selectors.join(',')));
}

function responseGenerating(node) {
  return isGenerating() || turnStreaming(node);
}

function completedTurnActionCount(node) {
  const turn = turnOf(node);
  if (!turn) return 0;
  const selectors = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[data-testid="bad-response-turn-action-button"]',
    'button[data-testid="regenerate-turn-action-button"]',
    'button[data-testid="share-turn-action-button"]',
    'button[data-testid="more-turn-action-button"]',
    'button[data-testid*="turn-action"]',
    'button[aria-label="Copy"]',
    'button[aria-label*="Good response"]',
    'button[aria-label*="Bad response"]',
    'button[aria-label*="Regenerate"]',
    'button[aria-label*="Share"]',
    'button[aria-label="复制"]',
    'button[aria-label*="重新生成"]',
    'button[aria-label*="分享"]',
  ];
  return new Set(turn.querySelectorAll(selectors.join(','))).size;
}

function hasCompletionEvidence(node) {
  return completedTurnActionCount(node) >= 2;
}

async function confirmDomSettled(
  node,
  submittedUser,
  prompt,
  expectedText,
  settleMs = 4000,
) {
  const started = Date.now();
  while (Date.now() - started < settleMs) {
    await sleep(400);
    const currentUser = assertTaskOwnsLatestUserTurn(submittedUser, prompt);
    const latest = assistantAfterUser(currentUser);
    if (!latest || latest !== node) return false;
    if (responseGenerating(latest)) return false;
    if (!hasCompletionEvidence(latest)) return false;
    if (extractDomAnswerText(latest) !== expectedText) return false;
  }
  return true;
}

async function waitForStableDomAnswer(initialNode, submittedUser, prompt, timeoutMs = 210000) {
  const started = Date.now();
  let node = initialNode;
  let lastText = '';
  let stableSince = Date.now();
  let quietSince = null;
  let samples = 0;
  let textChanges = 0;
  let nodeChanges = 0;
  let sawGenerating = false;
  let sawGeneratingTransition = false;

  while (Date.now() - started < timeoutMs) {
    const currentUser = assertTaskOwnsLatestUserTurn(submittedUser, prompt);
    const latest = assistantAfterUser(currentUser);
    if (!latest) {
      await sleep(400);
      continue;
    }
    if (latest !== node) {
      node = latest;
      lastText = '';
      stableSince = Date.now();
      quietSince = null;
      nodeChanges++;
    }

    const text = extractDomAnswerText(node);
    const generating = responseGenerating(node);
    if (generating) sawGenerating = true;
    else if (sawGenerating) sawGeneratingTransition = true;
    samples++;
    if (text !== lastText) {
      lastText = text;
      stableSince = Date.now();
      textChanges++;
    }
    if (generating) quietSince = null;
    else if (!quietSince) quietSince = Date.now();

    const stableMs = Date.now() - stableSince;
    const quietMs = quietSince ? Date.now() - quietSince : 0;
    const actionCount = completedTurnActionCount(node);
    const completionEvidence = hasCompletionEvidence(node);
    if (text && stableMs >= 8000 && quietMs >= 5000 && completionEvidence) {
      const settled = await confirmDomSettled(
        node,
        submittedUser,
        prompt,
        text,
        4000,
      );
      if (settled) {
        return {
          answer: text,
          diagnostics: {
            reason: 'stable_dom', rawLength: text.length, stableMs, quietMs,
            samples, textChanges, nodeChanges, generating: false,
            actionCount, sawGenerating, sawGeneratingTransition,
          },
        };
      }
      const refreshed = extractDomAnswerText(node);
      if (refreshed !== lastText) {
        lastText = refreshed;
        stableSince = Date.now();
        textChanges++;
      }
      if (responseGenerating(node)) quietSince = null;
    }
    await sleep(400);
  }

  const finalText = extractDomAnswerText(node);
  return {
    answer: '',
    diagnostics: {
      reason: 'dom_timeout', rawLength: finalText.length,
      stableMs: Date.now() - stableSince,
      quietMs: quietSince ? Date.now() - quietSince : 0,
      samples, textChanges, nodeChanges,
      generating: responseGenerating(node),
      streaming: turnStreaming(node),
      actionCount: completedTurnActionCount(node),
      sawGenerating, sawGeneratingTransition,
    },
  };
}

function conversationSignature() {
  const users = userNodes();
  const assistants = assistantNodes();
  return [
    users.length,
    assistants.length,
    rawTurnText(users.at(-1)).slice(-160),
    rawTurnText(assistants.at(-1)).slice(-160),
  ].join('|');
}

async function waitForConversationStable(timeoutMs = 15000, stableMs = 2500) {
  const started = Date.now();
  let lastSignature = '';
  let stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!composer()) {
      await sleep(250);
      continue;
    }
    const signature = conversationSignature();
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    }
    if (!isGenerating() && Date.now() - stableSince >= stableMs) return;
    await sleep(250);
  }
  throw new Error('ChatGPT conversation did not finish loading before automation started');
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

function clearComposerIfOwned(prompt) {
  const input = composer();
  if (!input) return;
  const current = normalizeText(composerText(input));
  const expected = normalizeText(prompt);
  if (!current || !expected || current !== expected) return;
  setPrompt(input, '');
}

async function waitForPromptApplied(prompt, timeoutMs = 5000) {
  const expected = normalizeText(prompt);
  return await waitFor(() => {
    const actual = normalizeText(composerText());
    return actual === expected ? true : null;
  }, timeoutMs, 100, 'ChatGPT composer did not accept the prompt text');
}

async function waitForSubmittedUserTurn(prompt, previousUsers, timeoutMs = 30000) {
  return await waitFor(() => {
    if (normalizeText(composerText())) return null;
    const latest = userNodes().at(-1);
    if (!latest || previousUsers.has(latest)) return null;
    return userTurnMatchesPrompt(latest, prompt) ? latest : null;
  }, timeoutMs, 200, 'ChatGPT did not confirm prompt submission; prompt was not sent');
}

function currentSubmittedUserTurn(originalNode, prompt) {
  if (originalNode?.isConnected) return originalNode;
  return [...userNodes()].reverse().find(node => userTurnMatchesPrompt(node, prompt)) || null;
}

function assertTaskOwnsLatestUserTurn(originalNode, prompt) {
  const current = currentSubmittedUserTurn(originalNode, prompt);
  if (!current || userNodes().at(-1) !== current) {
    throw new Error('ChatGPT worker tab changed during automation; refusing to return a possibly stale answer');
  }
  return current;
}

function assistantAfterUser(userNode) {
  if (!userNode?.isConnected) return null;
  return assistantNodes().find(node => nodeFollows(userNode, node)) || null;
}

async function findSendButton(timeoutMs = 8000) {
  return await waitFor(() => {
    const found = document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="发送"]');
    return found && !found.disabled ? found : null;
  }, timeoutMs, 250, 'ChatGPT send button did not become ready');
}

async function submitPromptAndConfirm(prompt, previousUsers, timeoutMs = 30000) {
  const button = await findSendButton(Math.min(timeoutMs, 10000));
  button.focus();
  button.click();

  try {
    return await waitForSubmittedUserTurn(prompt, previousUsers, 5000);
  } catch {}

  const current = normalizeText(composerText());
  const expected = normalizeText(prompt);
  if (!current) {
    return await waitForSubmittedUserTurn(prompt, previousUsers, timeoutMs);
  }
  if (current !== expected) {
    throw new Error('ChatGPT composer changed after send attempt; refusing to retry submission');
  }

  const form = button.closest('form') || composer()?.closest('form');
  if (!form?.requestSubmit) {
    throw new Error('ChatGPT did not confirm prompt submission; prompt was not sent');
  }

  console.warn('[send] click was not acknowledged; retrying with form.requestSubmit()');
  form.requestSubmit(button);
  return await waitForSubmittedUserTurn(prompt, previousUsers, timeoutMs);
}

const ATTACHMENT_MARKER_SELECTORS = [
  '[data-testid="file-thumbnail"]',
  '[data-testid*="attachment-preview"]',
  '[data-testid*="file-preview"]',
  '[data-testid*="composer-attachment"]',
  '[data-testid*="attachment"]',
  'img[src^="blob:"]',
  'button[aria-label^="Remove "]',
  'button[aria-label^="Delete "]',
  'button[aria-label*="Remove file"]',
  'button[aria-label*="Remove image"]',
  'button[aria-label*="Remove attachment"]',
  'button[aria-label*="remove file"]',
  'button[aria-label*="remove image"]',
  'button[aria-label*="remove attachment"]',
  'button[aria-label*="移除文件"]',
  'button[aria-label*="移除图片"]',
  'button[aria-label*="移除附件"]',
  'button[aria-label*="删除文件"]',
  'button[aria-label*="删除图片"]',
  'button[aria-label*="删除附件"]',
  'img[alt*="Uploaded"]',
  'img[alt*="uploaded"]',
  'img[alt*="上传"]',
];

function attachmentMarkerNodes() {
  return [...document.querySelectorAll(ATTACHMENT_MARKER_SELECTORS.join(','))];
}

function removeAttachmentButtons() {
  return attachmentMarkerNodes().filter(node =>
    node instanceof HTMLButtonElement &&
    /remove|移除|删除/i.test(node.getAttribute('aria-label') || '')
  );
}

async function clearPendingAttachments(previousButtons = new Set()) {
  const added = removeAttachmentButtons().filter(button => !previousButtons.has(button));
  for (const button of added.reverse()) button.click();
  if (added.length) await sleep(250);
}

function decodeAttachment(attachment) {
  const encoded = String(attachment?.dataBase64 || '');
  if (!encoded) throw new Error(`Attachment data is missing: ${attachment?.name || 'unknown'}`);
  let binary;
  try { binary = atob(encoded); } catch {
    throw new Error(`Attachment data is invalid: ${attachment?.name || 'unknown'}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], attachment.name || 'attachment', {
    type: attachment.mime || 'application/octet-stream',
  });
}

function usableFileInput() {
  const root = composerRoot();
  const local = [...(root?.querySelectorAll?.('input[type="file"]') || [])]
    .filter(input => !input.disabled);
  if (local.length) return local[local.length - 1];

  const all = [...document.querySelectorAll('input[type="file"]')]
    .filter(input => !input.disabled);
  return all[all.length - 1] || null;
}

async function findFileInput() {
  const openButton = document.querySelector('button[data-testid="composer-plus-btn"]') ||
    document.querySelector('button[aria-label*="Attach"]') ||
    document.querySelector('button[aria-label*="Add files"]') ||
    document.querySelector('button[aria-label*="Add photos"]') ||
    document.querySelector('button[aria-label*="添加照片"]') ||
    document.querySelector('button[aria-label*="上传"]');

  const menuOpen = Boolean(document.querySelector('[role="menu"]'));
  if (openButton && !menuOpen) {
    openButton.click();
    await sleep(300);
  }

  return await waitFor(
    usableFileInput,
    3000,
    100,
    'ChatGPT attachment input did not appear',
  ).catch(() => null);
}

function composerRoot() {
  const input = composer();
  return input?.closest('form') || input?.parentElement?.parentElement || document.body;
}

function textOccurrenceCount(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while ((start = text.indexOf(needle, start)) >= 0) {
    count++;
    start += needle.length;
  }
  return count;
}

function fileNameMarkers(name) {
  const root = composerRoot();
  let count = textOccurrenceCount(root?.innerText || '', name);
  for (const node of root?.querySelectorAll?.('[aria-label],[title]') || []) {
    count += textOccurrenceCount(node.getAttribute('aria-label') || '', name);
    count += textOccurrenceCount(node.getAttribute('title') || '', name);
  }
  return count;
}

function attachmentUploadBusy() {
  const root = composerRoot();
  const selectors = [
    '[data-testid*="upload-progress"]',
    '[data-testid*="uploading"]',
    '[data-state="uploading"]',
    '[data-status="uploading"]',
    '[aria-label*="Uploading"]',
    '[aria-label*="uploading"]',
    '[aria-label*="上传中"]',
  ];
  return Boolean(root?.querySelector?.(selectors.join(',')));
}

function attachmentDomSummary() {
  const root = composerRoot();
  const nodes = [...(root?.querySelectorAll?.('img,button,input,[data-testid],[aria-label],[role]') || [])];
  return nodes.slice(-40).map(node => {
    const parts = [node.tagName.toLowerCase()];
    for (const attr of ['data-testid', 'aria-label', 'alt', 'title', 'role', 'data-state']) {
      const value = node.getAttribute?.(attr);
      if (value) parts.push(`${attr}=${JSON.stringify(value.slice(0, 120))}`);
    }
    const src = node.getAttribute?.('src');
    if (src) parts.push(`src=${JSON.stringify(src.slice(0, 100))}`);
    return `<${parts.join(' ')}>`;
  }).join(' | ').slice(0, 4000);
}

async function attachFiles(attachments) {
  if (!attachments?.length) return;
  const files = attachments.map(decodeAttachment);
  const previousButtons = new Set(removeAttachmentButtons());

  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const input = await findFileInput();
      if (!input) {
        throw new Error('ChatGPT attachment input was not found; reload the extension and ChatGPT tab');
      }

      const markerBefore = attachmentMarkerNodes().length;
      const removeBefore = removeAttachmentButtons().length;
      const nameBefore = fileNameMarkers(file.name);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const confirmed = await waitFor(() =>
        attachmentMarkerNodes().length > markerBefore ||
        removeAttachmentButtons().length > removeBefore ||
        fileNameMarkers(file.name) > nameBefore,
      30000, 250, `ChatGPT did not confirm attachment preview for ${file.name}`)
        .then(() => true)
        .catch(() => false);

      if (!confirmed) {
        const currentInput = usableFileInput();
        throw new Error(
          `ChatGPT did not confirm attachment preview for "${file.name}" ` +
          `(${index + 1}/${files.length}); type=${file.type || 'unknown'}, size=${file.size}, ` +
          `markers=${attachmentMarkerNodes().length}, removeButtons=${removeAttachmentButtons().length}, ` +
          `input.multiple=${Boolean(currentInput?.multiple)}, accept="${currentInput?.accept || ''}"; ` +
          `composer=${attachmentDomSummary()}`,
        );
      }

      await waitFor(
        () => !attachmentUploadBusy(),
        30000,
        250,
        `ChatGPT attachment upload did not finish for "${file.name}"`,
      );
      await sleep(150);
    }
  } catch (error) {
    await clearPendingAttachments(previousButtons);
    throw error;
  }
  return previousButtons;
}

async function runPrompt(prompt, attachments = []) {
  if (conversationMissing()) throw new Error('STALE_CONVERSATION');

  await waitFor(composer, 20000);
  await waitForConversationStable();
  if (normalizeText(composerText())) {
    throw new Error('ChatGPT worker composer is not empty before this task; clear the unsent draft and retry');
  }

  const previousButtons = await attachFiles(attachments);
  let sent = false;
  let submittedUser = null;
  try {
    const input = await waitFor(composer, 20000);
    setPrompt(input, prompt);
    await waitForPromptApplied(prompt);
    const previousUsers = new Set(userNodes());
    await sleep(300);
    submittedUser = await submitPromptAndConfirm(
      prompt,
      previousUsers,
      attachments.length ? 60000 : 30000,
    );
    sent = true;
  } catch (error) {
    if (!sent) {
      if (attachments.length) {
        await clearPendingAttachments(previousButtons || new Set());
      }
      clearComposerIfOwned(prompt);
    }
    throw error;
  }

  let node = await waitFor(() => {
    const currentUser = assertTaskOwnsLatestUserTurn(submittedUser, prompt);
    return assistantAfterUser(currentUser);
  }, 60000, 250, 'ChatGPT did not start a new assistant response for the submitted prompt');

  const domResult = await waitForStableDomAnswer(
    node,
    submittedUser,
    prompt,
    210000,
  );
  if (domResult.answer) {
    const currentUser = assertTaskOwnsLatestUserTurn(submittedUser, prompt);
    const finalNode = assistantAfterUser(currentUser);
    const generated = finalNode ?
      await collectGeneratedFiles(finalNode) : { files: [], errors: [], candidates: 0, debug: '' };
    return {
      answer: domResult.answer,
      files: generated.files,
      fileErrors: generated.errors,
      generatedFileCandidates: generated.candidates,
      generatedFileDebug: generated.debug || '',
    };
  }

  const d = domResult.diagnostics || {};
  const details = [
    'mode=dom',
    `rawLength=${d.rawLength || 0}`,
    `stableMs=${d.stableMs || 0}`,
    `quietMs=${d.quietMs || 0}`,
    `samples=${d.samples || 0}`,
    `textChanges=${d.textChanges || 0}`,
    `nodeChanges=${d.nodeChanges || 0}`,
    `streaming=${Boolean(d.streaming)}`,
    `actionCount=${d.actionCount || 0}`,
    `sawGenerating=${Boolean(d.sawGenerating)}`,
    `sawGeneratingTransition=${Boolean(d.sawGeneratingTransition)}`,
  ].join(', ');

  if (d.generating) {
    throw new Error(`ChatGPT generation still active after timeout; ${details}`);
  }
  throw new Error(
    `ChatGPT answer extraction timed out after generation appeared complete; ${details}`,
  );
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RUN_PROMPT') return;

  runPrompt(msg.prompt, msg.attachments || [])
    .then(result => sendResponse({
      ok: true,
      answer: result.answer,
      answerLength: result.answer.length,
      files: result.files || [],
      fileErrors: result.fileErrors || [],
      generatedFileCandidates: result.generatedFileCandidates || 0,
      generatedFileDebug: result.generatedFileDebug || '',
      conversationUrl: location.href,
    }))
    .catch(err => sendResponse({
      ok: false,
      error: String(err?.message || err),
      conversationUrl: location.href,
    }));
  return true;
});
