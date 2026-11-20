'use strict';
importScripts('page.js');
let socket = null,
  heartbeat = null,
  lastError = '',
  connectionUrl = '',
  initialTab = null;
const sessions = new Map(),
  attached = new Set(),
  cancelled = new Set();
let queue = Promise.resolve();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function assertUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('只支持普通 http(s) 网页。');
  return u.href;
}
async function attach(tabId) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  }
  return (method, params = {}) =>
    chrome.debugger.sendCommand({ tabId }, method, params);
}
async function getTab(session) {
  let id = sessions.get(session);
  if (id) {
    try {
      await chrome.tabs.get(id);
    } catch {
      sessions.delete(session);
      id = null;
    }
  }
  if (!id) {
    if (initialTab) {
      const tab = await chrome.tabs.get(initialTab).catch(() => null);
      initialTab = null;
      if (tab && /^https?:/.test(tab.url || '')) id = tab.id;
    }
    if (!id)
      id = (await chrome.tabs.create({ url: 'about:blank', active: true })).id;
    sessions.set(session, id);
  }
  return id;
}
async function perform(message) {
  const { id, session, op, args = {} } = message;
  const check = () => {
    if (cancelled.has(id)) throw new Error('已停止浏览器操作。');
  };
  check();
  const tabId = await getTab(session),
    cdp = await attach(tabId);
  const evaluate = async (action, options = {}) => {
    const result = await cdp('Runtime.evaluate', {
      expression: `(${portablePage.toString()})(${JSON.stringify(action)},${JSON.stringify(options)})`,
      returnByValue: true,
      awaitPromise: true,
      contextId: await isolated(),
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || '页面读取失败。',
      );
    return result.result?.value;
  };
  async function isolated() {
    const tree = await cdp('Page.getFrameTree');
    return (
      await cdp('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: 'codex-portable',
        grantUniveralAccess: false,
      })
    ).executionContextId;
  }
  if (op === 'focus') {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return { focused: true };
  }
  if (op === 'open') {
    await cdp('Page.enable');
    const result = await cdp('Page.navigate', { url: assertUrl(args.url) });
    if (result.errorText) throw new Error('网页打开失败：' + result.errorText);
    for (let i = 0; i < 24; i++) {
      check();
      await delay(500);
      try {
        const state = await cdp('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (state.result?.value !== 'loading') break;
      } catch {}
    }
    check();
    await delay(600);
    let page = await evaluate('read');
    for (
      let i = 0;
      i < 8 &&
      !page.gate &&
      !page.heading &&
      !page.comments?.length &&
      !page.links?.length;
      i++
    ) {
      check();
      await delay(500);
      page = await evaluate('read');
    }
    return page;
  }
  if (op === 'screenshot') {
    check();
    await cdp('Page.enable');
    return cdp('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
  }
  if (op === 'read') return evaluate('read');
  if (['click', 'fill', 'scroll'].includes(op)) {
    check();
    const acted = await evaluate(op, args);
    await delay(650);
    check();
    return { ...(await evaluate('read')), acted };
  }
  throw new Error('不支持的浏览器操作。');
}
function connect(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'ws:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== '/browser' ||
    !/^[a-f0-9]{64}$/.test(parsed.searchParams.get('token') || '')
  )
    throw new Error('请粘贴便携助手提供的完整配对信息。');
  connectionUrl = url;
  socket?.close();
  clearInterval(heartbeat);
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => {
    lastError = '';
    chrome.action.setBadgeText({ text: 'ON' });
    heartbeat = setInterval(() => {
      if (current.readyState === WebSocket.OPEN)
        current.send('{"type":"ping"}');
    }, 20000);
  };
  current.onmessage = ({ data }) => {
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (value.type === 'cancel') {
      cancelled.add(value.id);
      setTimeout(() => cancelled.delete(value.id), 30000);
      return;
    }
    if (value.type === 'pong') return;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (socket !== current || current.readyState !== WebSocket.OPEN) return;
        try {
          const result = await perform(value);
          if (current.readyState === WebSocket.OPEN && !cancelled.has(value.id))
            current.send(JSON.stringify({ id: value.id, result }));
        } catch (e) {
          if (current.readyState === WebSocket.OPEN)
            current.send(JSON.stringify({ id: value.id, error: e.message }));
        } finally {
          cancelled.delete(value.id);
        }
      });
  };
  current.onclose = () => {
    if (socket === current) {
      clearInterval(heartbeat);
      chrome.action.setBadgeText({ text: '' });
    }
  };
  current.onerror = () => {
    lastError = '连接未成功，请先打开便携助手，再重新复制配对信息。';
  };
}
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'status') {
    reply({
      connected: socket?.readyState === WebSocket.OPEN,
      error: lastError,
    });
    return;
  }
  (async () => {
    if (message.type === 'connect') {
      initialTab = message.tabId;
      connect(message.url);
      await chrome.storage.local.set({ pairUrl: message.url });
      chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
      return {};
    }
    if (message.type === 'disconnect') {
      connectionUrl = '';
      socket?.close();
      socket = null;
      clearInterval(heartbeat);
      await chrome.storage.local.remove('pairUrl');
      for (const tabId of attached)
        await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.clear();
      return {};
    }
    return {};
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(async () => {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  const { pairUrl } = await chrome.storage.local.get('pairUrl');
  if (pairUrl)
    try {
      connect(pairUrl);
    } catch {}
});
chrome.storage.local.get('pairUrl').then(({ pairUrl }) => {
  if (pairUrl)
    try {
      connect(pairUrl);
    } catch {}
});
