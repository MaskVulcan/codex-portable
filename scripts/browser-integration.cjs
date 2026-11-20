'use strict';
// Run the actual MV3 worker and CDP page actions against real Chromium pages.
const { chromium } = require('playwright');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { BrowserBridge } = require('../src/browser-bridge.cjs');
const { BrowserCollector } = require('../src/browser-collection.cjs');
const { CodexRpc } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/browser');
fs.mkdirSync(out, { recursive: true });
let bridge, rpc, browser, context;
const pages = new Map(),
  cdp = new Map(),
  timers = new Set();
let receive;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error('Browser smoke timed out');
}
const urls = [
  'https://www.xiaohongshu.com/explore/abc123?xsec_token=fixture',
  'https://www.xiaohongshu.com/explore/def456',
];
const render = (url) =>
  `<!doctype html><html><meta charset="utf-8"><style>body{font:18px sans-serif;background:#fff;color:#222}.note-scroller{height:460px;overflow:auto;padding:20px}.comment-item{padding:25px;border-bottom:1px solid #aaa}</style><title>专题采集测试</title><body>${url.includes('/login') ? '<div class="login-modal">请扫码登录</div>' : `<div class="note-scroller"><h1 id="detail-title">专题测试笔记</h1><div id="detail-desc">这是实际 Chromium 渲染的测试内容。</div><input placeholder="关键词"><button onclick="this.textContent='已点击'">测试按钮</button>${Array.from({ length: 15 }, (_, i) => `<div class="comment-item" data-comment-id="c${i}">评论 ${i + 1}：已加载的真实页面文字。</div>`).join('')}<div class="end-container">没有更多评论</div></div><a href="${urls[0]}">主题笔记一</a><a href="${urls[1]}">主题笔记二</a>`}</body></html>`;
async function openPage(url) {
  const page = await context.newPage();
  page.route('https://www.xiaohongshu.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: render(route.request().url()),
    }),
  );
  page.on('close', () => pages.delete(page));
  const id = pages.size + 1;
  pages.set(id, page);
  await page.goto(url);
  return { id, url: page.url(), windowId: id };
}
(async () => {
  browser = await chromium.launch({
    executablePath: process.env.TEST_CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context = await browser.newContext({
    viewport: { width: 1000, height: 780 },
  });
  const chromeApi = {
    debugger: {
      attach: async ({ tabId }) => {
        const page = pages.get(tabId);
        if (!page) throw Error('Missing tab');
        cdp.set(tabId, await context.newCDPSession(page));
      },
      detach: async ({ tabId }) => {
        await cdp.get(tabId)?.detach();
        cdp.delete(tabId);
      },
      sendCommand: async ({ tabId }, method, params) =>
        cdp.get(tabId).send(method, params),
      onDetach: { addListener() {} },
    },
    tabs: {
      get: async (id) => {
        const page = pages.get(id);
        if (!page) throw Error('Missing tab');
        return { id, url: page.url(), windowId: id };
      },
      create: openPage,
      update: async (id) => pages.get(id).bringToFront(),
    },
    windows: { update: async (id) => pages.get(id)?.bringToFront() },
    action: { setBadgeText() {} },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener: (fn) => (receive = fn) } },
  };
  const vmContext = vm.createContext({
    chrome: chromeApi,
    WebSocket,
    URL,
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval,
    console,
  });
  vmContext.importScripts = (file) =>
    vm.runInContext(
      fs.readFileSync(path.join(root, 'browser-extension', file), 'utf8'),
      vmContext,
    );
  vm.runInContext(
    fs.readFileSync(path.join(root, 'browser-extension/worker.js'), 'utf8'),
    vmContext,
  );
  const task = {
    id: 'browser-smoke',
    title: '专题测试',
    output: path.join(out, '成果'),
  };
  fs.rmSync(task.output, { recursive: true, force: true });
  let collector;
  bridge = new BrowserBridge({
    root: path.join(out, 'data'),
    port: 0,
    onCall: async (args) => {
      assert.equal(args.taskId, task.id);
      if (args.tool === 'browser_collect')
        return collector.collect({
          task,
          session: 'chat',
          urls: args.urls,
          commentPages: args.commentPages ?? 3,
        });
      if (args.tool === 'browser_screenshot')
        return {
          path: await collector.screenshot('chat', task.output, 'MCP截图'),
        };
      return bridge.request(
        'chat',
        args.tool === 'browser_open'
          ? 'open'
          : args.tool === 'browser_read'
            ? 'read'
            : args.action,
        args,
      );
    },
  });
  collector = new BrowserCollector({
    bridge,
    onProgress: (_task, detail) => console.log('Collect:', detail),
  });
  await bridge.start();
  const first = await openPage(urls[0]);
  await new Promise((resolve) =>
    receive(
      { type: 'connect', url: bridge.pairUrl(), tabId: first.id },
      {},
      resolve,
    ),
  );
  await until(() => bridge.status().connected);
  const page = await bridge.request('chat', 'read');
  assert.equal(page.heading, '专题测试笔记');
  assert.equal(page.links.length, 2);
  assert.equal(page.endVisible, false);
  const input = page.controls.find((v) => v.role === 'input');
  await bridge.request('chat', 'fill', { ref: input.ref, text: '专题关键词' });
  assert.equal(
    await pages.get(first.id).locator('input').inputValue(),
    '专题关键词',
  );
  const button = (await bridge.request('chat', 'read')).controls.find(
    (v) => v.text === '测试按钮',
  );
  await bridge.request('chat', 'click', { ref: button.ref });
  assert.equal(
    await pages.get(first.id).locator('button').textContent(),
    '已点击',
  );
  const result = await collector.collect({
    task,
    session: 'chat',
    urls,
    commentPages: 3,
  });
  assert.equal(result.completed, 2);
  assert.ok(result.screenshots >= 4);
  assert.equal(result.comments, 30);
  const login = await bridge.request('chat', 'open', {
    url: 'https://www.xiaohongshu.com/login',
  });
  assert.equal(login.gate, 'login');
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
  );
  rpc = new CodexRpc({
    executable: require('./test-env.cjs').codex,
    home: path.join(out, 'codex-home'),
    settings: config,
    browser: {
      python: require('./test-env.cjs').python,
      script: path.join(root, 'assets/browser_mcp.py'),
      connectionFile: bridge.file,
    },
    log: () => {},
  });
  await rpc.start();
  const inventory = await rpc.request('mcpServerStatus/list', {});
  assert.ok(
    inventory.data.find((s) => s.name === 'portable_browser').tools
      .browser_collect,
  );
  const { thread } = await rpc.request('thread/start', {
    cwd: out,
    model: config.model,
    modelProvider: 'portable_relay',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  const call = await rpc.request(
    'mcpServer/tool/call',
    {
      threadId: thread.id,
      server: 'portable_browser',
      tool: 'browser_open',
      arguments: { taskId: task.id, url: urls[0] },
    },
    30000,
  );
  assert.ok(JSON.stringify(call).includes('专题测试笔记'));
  const snap = await rpc.request(
    'mcpServer/tool/call',
    {
      threadId: thread.id,
      server: 'portable_browser',
      tool: 'browser_screenshot',
      arguments: { taskId: task.id },
    },
    30000,
  );
  assert.ok(JSON.stringify(snap).includes('MCP截图'));
  const modelTools = new Set();
  if (process.env.TEST_BROWSER_MODEL === '1') {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Real model browser task timed out')),
        120000,
      );
      rpc.on('notification', ({ method, params }) => {
        if (
          method === 'item/completed' &&
          params.threadId === thread.id &&
          params.item?.type === 'mcpToolCall' &&
          params.item?.status === 'completed'
        )
          modelTools.add(params.item.tool);
        if (method === 'turn/completed' && params.threadId === thread.id) {
          clearTimeout(timer);
          params.turn.status === 'failed'
            ? reject(new Error(params.turn.error?.message))
            : resolve();
        }
      });
    });
    await rpc.request('turn/start', {
      threadId: thread.id,
      input: [
        {
          type: 'text',
          text: `这是本地浏览器集成验证。请必须调用 portable_browser 的 browser_read，taskId=${task.id}，再 browser_screenshot 保存截图。不要执行 shell、不要联网到其他网站。最后只说页面标题和已保存截图。`,
        },
      ],
      effort: 'low',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    await done;
    assert.ok(
      modelTools.has('browser_read'),
      'Model did not actually read the browser',
    );
    assert.ok(
      modelTools.has('browser_screenshot'),
      'Model did not actually save a screenshot',
    );
  }
  const report = {
    passed: true,
    actualChromiumDomRead: true,
    actualChromiumScreenshot: true,
    actualExtensionWorkerWithChromeApiAdapters: true,
    loopbackWebSocket: true,
    actualPythonMcp: true,
    actualCodexMcpToolCalls: true,
    actualMcpStatusDiscovery: true,
    realModelToolUse: process.env.TEST_BROWSER_MODEL === '1',
    modelTools: [...modelTools],
    keywordInput: true,
    pageClick: true,
    batchNotes: result.completed,
    screenshots: result.screenshots,
    comments: result.comments,
    loginGate: true,
    nativeBrowserExtensionInstall: false,
    nativeWindowsRun: false,
    realXiaohongshuAccount: false,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('BROWSER INTEGRATION PASSED', JSON.stringify(report));
})()
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    rpc?.close();
    bridge?.close();
    for (const id of timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    for (const page of pages.values()) await page.close().catch(() => {});
    await browser?.close();
  });
