'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/novice');
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'data');
fs.rmSync(data, { recursive: true, force: true });
const distribution =
  process.env.TEST_PACKAGE_DIR || path.join(root, 'dist/win-unpacked');
process.env.PORTABLE_APP_DIR = distribution;
process.env.PORTABLE_DATA_DIR = data;
process.env.PORTABLE_PAYLOAD_DIR = path.join(distribution, 'config');
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
require(path.join(distribution, 'resources/app.asar/src/main.cjs'));
let main;
const js = (code) => main.webContents.executeJavaScript(code, true);
async function until(fn, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Novice flow timed out');
}
app
  .whenReady()
  .then(async () => {
    main = BrowserWindow.getAllWindows()[0];
    if (main.webContents.isLoading())
      await new Promise((r) => main.webContents.once('did-finish-load', r));
    await until(() => js("document.getElementById('onboarding').open"));
    fs.writeFileSync(
      path.join(out, 'first-use.png'),
      (await main.webContents.capturePage()).toPNG(),
    );
    await js("document.getElementById('onboarding-close').click()");
    const work = path.join(out, '工作区');
    fs.mkdirSync(work, { recursive: true });
    const a = await js(
        'window.portable.createChat(' + JSON.stringify(work) + ')',
      ),
      b = await js('window.portable.createChat(' + JSON.stringify(work) + ')');
    await js(
      'window.portable.saveDraft(' +
        JSON.stringify(a.id) +
        ',{text:"持久草稿A",attachments:[]})',
    );
    await js(
      'window.portable.saveDraft(' +
        JSON.stringify(b.id) +
        ',{text:"持久草稿B",attachments:[]})',
    );
    main.webContents.reload();
    if (main.webContents.isLoading())
      await new Promise((r) => main.webContents.once('did-finish-load', r));
    await until(() =>
      js("document.querySelectorAll('.history-item').length===2"),
    );
    assert.equal(await js("document.getElementById('onboarding').open"), false);
    await js('window.portable.getChat(' + JSON.stringify(a.id) + ')');
    const draft = await js(
      'window.portable.getDraft(' + JSON.stringify(a.id) + ')',
    );
    assert.equal(draft.text, '持久草稿A');
    await js('window.portable.archiveChat(' + JSON.stringify(a.id) + ')');
    assert.equal((await js('window.portable.listArchived()')).length, 1);
    await js('window.portable.restoreChat(' + JSON.stringify(a.id) + ')');
    assert.equal((await js('window.portable.listChats()')).length, 2);
    const report = {
      passed: true,
      realElectron: true,
      builtApplication: true,
      firstUseGuideVisible: true,
      firstUseGuideDismissalPersisted: true,
      persistentDraftsIndependent: true,
      archiveRestore: true,
      platform: process.platform,
      nativeWindowsRun: false,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('NOVICE ELECTRON FLOW PASSED');
  })
  .catch((e) => {
    console.error('NOVICE FLOW FAILED:', e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
