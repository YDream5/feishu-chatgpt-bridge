const WS_URL = 'ws://127.0.0.1:17331';
const HEALTH_ALARM = 'bridge-health';
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let chain = Promise.resolve();

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
});
chrome.runtime.onStartup.addListener(() => {
  ensureHealthAlarm();
  ensureConnection();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === HEALTH_ALARM) ensureConnection();
});

ensureHealthAlarm();
ensureConnection();

async function getWorkerTab() {
  const saved = await chrome.storage.local.get(['workerTabId']);
  if (saved.workerTabId) {
    try { return await chrome.tabs.get(saved.workerTabId); } catch {}
  }
  const tab = await chrome.tabs.create({
    url: 'https://chatgpt.com/', active: true,
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
    url: 'https://chatgpt.com/', active: true,
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
    else await chrome.tabs.update(tab.id, { active: true });
    return { tab, sessions, targetUrl: null };
  }

  if (!sameConversation(tab.url, targetUrl)) {
    tab = await chrome.tabs.update(tab.id, {
      url: targetUrl, active: true,
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

  await chrome.tabs.update(tab.id, { active: true });
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
    id: msg.id, prompt: msg.prompt,
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
      id: msg.id, prompt: msg.prompt,
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
      type: 'result', id: msg.id, answer: result.answer,
    }));
  } catch (err) {
    socket?.send(JSON.stringify({
      type: 'error', id: msg.id,
      error: String(err?.message || err),
    }));
  }
}
