const WS_URL = 'ws://127.0.0.1:17331';
const HEALTH_ALARM = 'bridge-health';
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let chain = Promise.resolve();

const GENERATED_FILE_MAX_BYTES = 20 * 1024 * 1024;

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

async function fetchGeneratedFileInBackground(msg) {
  const maxBytes = Math.min(
    GENERATED_FILE_MAX_BYTES,
    Math.max(1, Number(msg.maxBytes) || GENERATED_FILE_MAX_BYTES),
  );
  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`unsupported generated file URL: ${url.slice(0, 80)}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(url, { credentials: 'include', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  return {
    name: fileNameFromDisposition(response.headers.get('content-disposition'), msg.fileName || 'generated-file'),
    mime: response.headers.get('content-type') || 'application/octet-stream',
    size: buffer.byteLength,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

function safeGeneratedDownloadName(name) {
  return String(name || 'generated-file')
    .replace(/[\\/:*?\"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'generated-file';
}

function downloadLooksRelated(item, capture) {
  if (!capture || !item) return false;
  const started = Date.parse(item.startTime || '') || Date.now();
  if (started + 3000 < capture.startedAt) return false;
  const haystack = [
    item.url, item.finalUrl, item.referrer, item.filename,
  ].map(value => String(value || '').toLowerCase()).join(' ');
  const expected = capture.fileName.toLowerCase();
  return haystack.includes(expected) ||
    /chatgpt\.com|oaiusercontent\.com|openai\.com/.test(haystack);
}

async function clickLatestAssistantDownload(tabId, fileName) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: expectedName => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const assistant = assistants.at(-1);
      const turn = assistant?.closest('[data-testid^="conversation-turn-"]') || assistant;
      if (!turn) return { clicked: false, reason: 'assistant turn missing' };
      const expected = String(expectedName || '').toLowerCase();
      const controls = [...turn.querySelectorAll('a[href],button,[role="button"],[download]')];
      const labelOf = el => `${el.getAttribute?.('aria-label') || ''} ${el.innerText || el.textContent || ''}`.trim();
      const fileControl = controls.find(el => labelOf(el).toLowerCase().includes(expected));
      let scope = fileControl;
      for (let i = 0; scope && i < 5; i++, scope = scope.parentElement) {
        const nearby = [...scope.querySelectorAll?.('button,[role="button"]') || []]
          .find(el => /download file|下载文件|下载/.test(labelOf(el).toLowerCase()));
        if (nearby) {
          nearby.click();
          return { clicked: true, label: labelOf(nearby) };
        }
      }
      if (fileControl && fileControl.matches?.('a[href],[download],button,[role="button"]')) {
        fileControl.click();
        return { clicked: true, label: labelOf(fileControl), direct: true };
      }
      const generic = controls.find(el => /download file|下载文件/.test(labelOf(el).toLowerCase())) ||
        controls.find(el => /下载/.test(labelOf(el)));
      if (!generic) return { clicked: false, reason: 'download button missing' };
      generic.click();
      return { clicked: true, label: labelOf(generic) };
    },
    args: [fileName],
  });
  return results?.[0]?.result || { clicked: false, reason: 'script returned no result' };
}

async function fetchGeneratedBlobInTab(tabId, url, fileName, maxBytes) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (sourceUrl, name, limit) => {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > limit) throw new Error(`file exceeds ${limit} bytes`);
      const bytes = new Uint8Array(buffer);
      const chunks = [];
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)));
      }
      return {
        name,
        mime: response.headers.get('content-type') || 'application/octet-stream',
        size: buffer.byteLength,
        dataBase64: btoa(chunks.join('')),
      };
    },
    args: [url, fileName, maxBytes],
  });
  const file = results?.[0]?.result;
  if (!file?.dataBase64) throw new Error('blob download could not be read from ChatGPT page');
  return file;
}

async function captureGeneratedFileFromPage(tabId, fileName, maxBytes) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (expectedName, limit) => {
      const FILE_RE = /\.(?:pdf|xlsx?|csv|docx|pptx|zip)(?:[?#]|$)/i;
      const TYPE_RE = /pdf|spreadsheet|excel|csv|word|officedocument|presentation|zip|octet-stream/i;
      const observations = [];
      let settled = false;
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      const originalFetch = window.fetch.bind(window);
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      const originalXhrOpen = XMLHttpRequest.prototype.open;
      const originalXhrSend = XMLHttpRequest.prototype.send;
      const remember = value => {
        const text = String(value || '').slice(0, 300);
        if (text && !observations.includes(text) && observations.length < 20) observations.push(text);
      };
      const toBase64 = buffer => {
        const bytes = new Uint8Array(buffer);
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        }
        return btoa(chunks.join(''));
      };
      const fileNameFromDisposition = (value, fallback) => {
        const text = String(value || '');
        const utf8 = text.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8) { try { return decodeURIComponent(utf8[1].replace(/["']/g, '')); } catch {} }
        const plain = text.match(/filename\s*=\s*"?([^";]+)"?/i);
        return plain?.[1]?.trim() || fallback;
      };
      const bufferMatchesExpected = (buffer, name) => {
        const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
        const lower = String(name || expectedName || '').toLowerCase();
        if (lower.endsWith('.pdf')) {
          return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
        }
        if (/\.(xlsx|docx|pptx|zip)$/.test(lower)) {
          return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
        }
        if (lower.endsWith('.xls')) {
          const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
          return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
        }
        if (lower.endsWith('.csv')) return bytes.length > 0 && !bytes.subarray(0, 256).includes(0);
        return true;
      };
      const settleBuffer = async (buffer, mime, name, source) => {
        if (settled || !buffer?.byteLength || buffer.byteLength > limit) return;
        const effectiveName = name || expectedName;
        if (!bufferMatchesExpected(buffer, effectiveName)) {
          const head = [...new Uint8Array(buffer.slice(0, 8))].map(v => v.toString(16).padStart(2, '0')).join('');
          remember(`${source} rejected magic name=${effectiveName} head=${head}`);
          return;
        }
        settled = true;
        remember(`${source} ${mime || ''} ${buffer.byteLength}B`);
        finish({
          ok: true,
          file: {
            name: name || expectedName,
            mime: mime || 'application/octet-stream',
            size: buffer.byteLength,
            dataBase64: toBase64(buffer),
          },
          observations,
        });
      };
      const inspectResponse = async (response, source) => {
        try {
          const url = String(response?.url || '');
          const type = String(response?.headers?.get?.('content-type') || '');
          const disposition = String(response?.headers?.get?.('content-disposition') || '');
          const declared = Number(response?.headers?.get?.('content-length') || 0);
          remember(`${source} url=${url} type=${type} disposition=${disposition}`);
          const likely = FILE_RE.test(url) || TYPE_RE.test(type) || /attachment|filename=/i.test(disposition);
          if (!likely || settled || declared > limit) return;
          const buffer = await response.clone().arrayBuffer();
          await settleBuffer(
            buffer,
            type,
            fileNameFromDisposition(disposition, expectedName),
            source,
          );
        } catch (error) {
          remember(`${source} inspect error=${error?.message || error}`);
        }
      };
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        inspectResponse(response, 'fetch');
        return response;
      };
      URL.createObjectURL = function(value) {
        try {
          if (value instanceof Blob) {
            remember(`blob type=${value.type} size=${value.size}`);
            if (!settled && value.size > 0 && value.size <= limit && TYPE_RE.test(value.type || 'application/octet-stream')) {
              value.arrayBuffer().then(buffer => settleBuffer(buffer, value.type, expectedName, 'createObjectURL'));
            }
          }
        } catch {}
        return originalCreateObjectURL(value);
      };
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__feishuGeneratedUrl = String(url || '');
        return originalXhrOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('loadend', () => {
          try {
            const url = String(this.responseURL || this.__feishuGeneratedUrl || '');
            const type = String(this.getResponseHeader('content-type') || '');
            const disposition = String(this.getResponseHeader('content-disposition') || '');
            remember(`xhr url=${url} type=${type} disposition=${disposition}`);
            if (!settled && (FILE_RE.test(url) || TYPE_RE.test(type) || /attachment|filename=/i.test(disposition)) && /^https?:/i.test(url)) {
              originalFetch(url, { credentials: 'include' }).then(response => inspectResponse(response, 'xhr-refetch')).catch(() => {});
            }
          } catch {}
        }, { once: true });
        return originalXhrSend.apply(this, args);
      };
      let triggerElement = null;
      HTMLAnchorElement.prototype.click = function(...args) {
        if (this === triggerElement) return originalAnchorClick.apply(this, args);
        const href = String(this.href || this.getAttribute('href') || '');
        const download = String(this.getAttribute('download') || '');
        if (!settled && (/^blob:/i.test(href) || ((download || FILE_RE.test(href)) && /^https?:/i.test(href)))) {
          remember(`anchor href=${href} download=${download}`);
          originalFetch(href, { credentials: 'include' })
            .then(response => inspectResponse(response, 'anchor'))
            .catch(error => remember(`anchor fetch error=${error?.message || error}`));
          return;
        }
        return originalAnchorClick.apply(this, args);
      };

      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const assistant = assistants.at(-1);
      const turn = assistant?.closest('[data-testid^="conversation-turn-"]') || assistant;
      const expected = String(expectedName || '').toLowerCase();
      const controls = [...(turn?.querySelectorAll?.('a[href],button,[role="button"],[download]') || [])];
      const labelOf = el => `${el.getAttribute?.('aria-label') || ''} ${el.innerText || el.textContent || ''}`.trim();
      triggerElement = controls.find(el => {
        const label = labelOf(el).toLowerCase();
        return label.includes(expected) && /download|\u4e0b\u8f7d|file/.test(label);
      }) || controls.find(el => labelOf(el).toLowerCase().includes(expected)) ||
        controls.find(el => /download file|\u4e0b\u8f7d\u6587\u4ef6|\u4e0b\u8f7d/i.test(labelOf(el)));
      if (!triggerElement) finish({ ok: false, error: 'page download control missing', observations });
      else {
        remember(`click ${triggerElement.tagName} ${labelOf(triggerElement)}`);
        triggerElement.click();
      }
      const timeout = setTimeout(() => {
        if (!settled) finish({
          ok: false,
          error: 'page network capture timed out',
          observations,
        });
      }, 20000);
      const output = await result;
      clearTimeout(timeout);
      window.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
      return output;
    },
    args: [fileName, maxBytes],
  });
  return results?.[0]?.result || {
    ok: false,
    error: 'page capture script returned no result',
    observations: [],
  };
}

async function captureGeneratedDownload(tabId, msg) {
  if (!tabId) throw new Error('worker tab id is missing');
  const fileName = safeGeneratedDownloadName(msg.fileName);
  const maxBytes = Math.min(
    GENERATED_FILE_MAX_BYTES,
    Math.max(1, Number(msg.maxBytes) || GENERATED_FILE_MAX_BYTES),
  );
  const pageCapture = await captureGeneratedFileFromPage(tabId, fileName, maxBytes)
    .catch(error => ({ ok: false, error: String(error?.message || error), observations: [] }));
  if (pageCapture?.ok && pageCapture.file?.dataBase64) {
    console.log(`[generated page capture] ${fileName} ${pageCapture.file.size || 0}B`);
    return pageCapture.file;
  }
  const pageCaptureDetail =
    `${pageCapture?.error || 'unknown'}; observations=` +
    JSON.stringify(pageCapture?.observations || []).slice(0, 1800);
  console.warn(`[generated page capture miss] ${fileName}: ${pageCaptureDetail}`);

  const startedAt = Date.now();
  let originalId = null;
  let processing = false;
  let settled = false;

  return await new Promise(async (resolve, reject) => {
    const cleanup = () => {
      chrome.downloads.onCreated.removeListener(onCreated);
      clearTimeout(timer);
    };
    const fail = async error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (originalId) {
        await chrome.downloads.cancel(originalId).catch(() => {});
        await chrome.downloads.erase({ id: originalId }).catch(() => {});
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const captureBytes = async item => {
      if (processing || settled) return;
      processing = true;
      originalId = item.id;
      const sourceUrl = String(item.finalUrl || item.url || '');
      try {
        // Trigger the page download only to reveal ChatGPT's real file URL.
        // Cancel immediately, then fetch bytes in memory so no Save As flow occurs.
        await chrome.downloads.cancel(originalId).catch(() => {});
        await chrome.downloads.erase({ id: originalId }).catch(() => {});
        if (!sourceUrl) throw new Error('captured download URL is empty');

        let file;
        if (/^https?:\/\//i.test(sourceUrl)) {
          file = await fetchGeneratedFileInBackground({
            url: sourceUrl,
            fileName,
            maxBytes,
          });
        } else if (/^blob:/i.test(sourceUrl)) {
          file = await fetchGeneratedBlobInTab(tabId, sourceUrl, fileName, maxBytes);
        } else {
          throw new Error(`unsupported captured download URL: ${sourceUrl.slice(0, 80)}`);
        }

        if (settled) return;
        settled = true;
        cleanup();
        console.log(`[generated download] captured in memory from ${new URL(sourceUrl).protocol}`);
        resolve(file);
      } catch (error) {
        await fail(new Error(`generated-file memory capture failed: ${error?.message || error}`));
      }
    };
    const onCreated = item => {
      if (settled || processing) return;
      const capture = { fileName, startedAt };
      if (downloadLooksRelated(item, capture)) {
        captureBytes(item).catch(fail);
      }
    };
    chrome.downloads.onCreated.addListener(onCreated);
    const timer = setTimeout(() => fail(new Error(`generated file download capture timed out; pageCapture=${pageCaptureDetail}`)), 15000);

    try {
      const clicked = await clickLatestAssistantDownload(tabId, fileName);
      if (!clicked?.clicked) throw new Error(clicked?.reason || 'generated file download button was not clicked');
    } catch (error) {
      await fail(error);
    }
  });
}
let lastGeneratedTempSweepAt = 0;
async function sweepGeneratedTempDownloads(maxAgeMs = 60 * 60 * 1000) {
  if (Date.now() - lastGeneratedTempSweepAt < 10 * 60 * 1000) return;
  lastGeneratedTempSweepAt = Date.now();
  const items = await chrome.downloads.search({});
  const cutoff = Date.now() - maxAgeMs;
  for (const item of items) {
    const filename = String(item.filename || '').replace(/\\/g, '/').toLowerCase();
    if (!filename.includes('/feishu-chatgpt-tmp/')) continue;
    const endedAt = Date.parse(item.endTime || item.startTime || '') || 0;
    if (endedAt && endedAt > cutoff) continue;
    await chrome.downloads.removeFile(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  }
}

function ensureHealthAlarm() {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
}

function ensureConnection() {
  if (socket && (socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING)) return;
  connect();
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(WS_URL);
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: 'hello', version: chrome.runtime.getManifest().version,
    }));
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  };
  socket.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type !== 'ask') return;
    chain = chain.then(() => runTask(msg)).catch(err => console.error(err));
  };
  socket.onclose = () => {
    clearInterval(heartbeatTimer);
    socket = null;
    reconnectTimer = setTimeout(ensureConnection, 1500);
  };
  socket.onerror = () => socket?.close();
}

chrome.runtime.onInstalled.addListener(() => {
  ensureHealthAlarm();
  ensureConnection();
  sweepGeneratedTempDownloads().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureHealthAlarm();
  ensureConnection();
  sweepGeneratedTempDownloads().catch(() => {});
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FETCH_GENERATED_FILE') {
    fetchGeneratedFileInBackground(msg)
      .then(file => sendResponse({ ok: true, file }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'CAPTURE_GENERATED_DOWNLOAD') {
    captureGeneratedDownload(sender.tab?.id, msg)
      .then(file => sendResponse({ ok: true, file }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === HEALTH_ALARM) {
    ensureConnection();
    sweepGeneratedTempDownloads().catch(() => {});
  }
});

ensureHealthAlarm();
ensureConnection();

async function getWorkerTab() {
  const saved = await chrome.storage.local.get(['workerTabId']);
  if (saved.workerTabId) {
    try { return await chrome.tabs.get(saved.workerTabId); } catch {}
  }
  const tab = await chrome.tabs.create({
    url: 'https://chatgpt.com/', active: false,
  });
  await chrome.storage.local.set({ workerTabId: tab.id });
  return tab;
}

function waitTabReady(tabId, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    try {
      const current = await chrome.tabs.get(tabId);
      if (current.status === 'complete') return resolve();
    } catch {}

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('ChatGPT tab load timeout'));
    }, timeoutMs);

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isHomeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://chatgpt.com' && u.pathname === '/';
  } catch { return false; }
}

function sameConversation(current, target) {
  return Boolean(current && target && current.startsWith(target));
}
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, files: ['content.js'],
  });
  await new Promise(r => setTimeout(r, 250));
}

async function sendPrompt(tabId, payload) {
  let lastError;
  let injected = false;
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'RUN_PROMPT', ...payload,
      });
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      if (!injected && /Receiving end does not exist|Could not establish connection/i.test(message)) {
        await injectContentScript(tabId);
        injected = true;
        continue;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError || new Error('ChatGPT content script unavailable');
}
async function openHome(tab) {
  const next = await chrome.tabs.update(tab.id, {
    url: 'https://chatgpt.com/', active: false,
  });
  await waitTabReady(next.id);
  return await chrome.tabs.get(next.id);
}

async function prepareSession(sessionKey) {
  const saved = await chrome.storage.local.get(['sessions']);
  const sessions = saved.sessions || {};
  const targetUrl = sessions[sessionKey] || null;
  let tab = await getWorkerTab();

  if (!targetUrl) {
    if (!isHomeUrl(tab.url)) tab = await openHome(tab);
    return { tab, sessions, targetUrl: null };
  }

  if (!sameConversation(tab.url, targetUrl)) {
    tab = await chrome.tabs.update(tab.id, {
      url: targetUrl,
    });
    await waitTabReady(tab.id);
    tab = await chrome.tabs.get(tab.id);
  }
  if (!sameConversation(tab.url, targetUrl)) {
    delete sessions[sessionKey];
    await chrome.storage.local.set({ sessions });
    tab = await openHome(tab);
    return { tab, sessions, targetUrl: null };
  }

  return { tab, sessions, targetUrl };
}

async function clearSession(sessionKey) {
  const saved = await chrome.storage.local.get(['sessions']);
  const sessions = saved.sessions || {};
  delete sessions[sessionKey];
  await chrome.storage.local.set({ sessions });
}

async function retryFromNewChat(tab, msg, sessions) {
  delete sessions[msg.sessionKey];
  await chrome.storage.local.set({ sessions });
  tab = await openHome(tab);
  return await sendPrompt(tab.id, {
    id: msg.id, prompt: msg.prompt, attachments: msg.attachments || [],
  });
}
async function runTask(msg) {
  try {
    if (String(msg.prompt || '').trim() === '/new') {
      await clearSession(msg.sessionKey);
      socket?.send(JSON.stringify({
        type: 'result', id: msg.id,
        answer: '✅ 当前飞书会话的 ChatGPT 上下文已清空，下一条消息会开启新对话。',
      }));
      return;
    }

    let { tab, sessions } = await prepareSession(msg.sessionKey);
    await waitTabReady(tab.id);

    let result = await sendPrompt(tab.id, {
      id: msg.id, prompt: msg.prompt, attachments: msg.attachments || [],
    });

    if (!result?.ok && /STALE_CONVERSATION/.test(result?.error || '')) {
      result = await retryFromNewChat(tab, msg, sessions);
    }
    if (!result?.ok) {
      throw new Error(result?.error || 'ChatGPT page automation failed');
    }

    if (result.conversationUrl?.includes('/c/')) {
      sessions[msg.sessionKey] = result.conversationUrl;
      await chrome.storage.local.set({ sessions });
    }

    socket?.send(JSON.stringify({
      type: 'result',
      id: msg.id,
      answer: result.answer,
      files: result.files || [],
      fileErrors: result.fileErrors || [],
      generatedFileCandidates: result.generatedFileCandidates || 0,
      generatedFileDebug: result.generatedFileDebug || '',
    }));
  } catch (err) {
    socket?.send(JSON.stringify({
      type: 'error', id: msg.id,
      error: String(err?.message || err),
    }));
  }
}
