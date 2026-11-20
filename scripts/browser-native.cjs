'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { BrowserBridge } = require('../src/browser-bridge.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/browser-native');
fs.mkdirSync(out, { recursive: true });
let bridge, context, server;
const wait = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Native extension connection timed out');
};
(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html><title>浏览器原生扩展测试</title><body><h1 id="detail-title">连接成功</h1><p id="detail-desc">已登录浏览器中的页面</p><input placeholder="主题"><button onclick="this.innerText=\'完成\'">按钮</button><div class="comment-item" data-comment-id="1">评论内容</div></body></html>',
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  bridge = new BrowserBridge({
    root: path.join(out, 'bridge'),
    port: 0,
    onCall: async () => ({}),
  });
  await bridge.start();
  const ext = path.join(root, 'browser-extension');
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    executablePath: process.env.TEST_CHROMIUM,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions-except=' + ext,
      '--load-extension=' + ext,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker)
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.fill('#pair', bridge.pairUrl());
  await popup.click('#connect');
  await wait(() => bridge.status().connected);
  await bridge.request('native', 'open', {
    url: `http://127.0.0.1:${server.address().port}`,
  });
  const read = await bridge.request('native', 'read');
  assert.equal(read.heading, '连接成功');
  assert.equal(read.comments[0].text, '评论内容');
  const png = await bridge.request('native', 'screenshot');
  const data = Buffer.from(png.data, 'base64');
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.writeFileSync(path.join(out, 'native-browser.png'), data);
  await popup.click('#disconnect');
  await wait(() => !bridge.status().connected);
  const report = {
    passed: true,
    nativeChromiumExtensionInstalled: true,
    actualPopupPairing: true,
    actualChromeDebuggerApi: true,
    visiblePageRead: true,
    screenshotPng: true,
    disconnect: true,
    platform: process.platform,
    nativeWindowsRun: false,
    realXiaohongshuAccount: false,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('NATIVE EXTENSION PASSED', JSON.stringify(report));
})()
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    bridge?.close();
    await context?.close();
    server?.close();
  });
