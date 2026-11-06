'use strict';
// Run with the real Electron executable, including its preload and clipboard.
const {
  app,
  BrowserWindow,
  clipboard,
  nativeImage,
  ClipboardItem,
} = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/electron');
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'data');
fs.mkdirSync(data, { recursive: true });
process.env.PORTABLE_DATA_DIR = data;
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
if (process.env.TEST_PACKAGE_DIR) {
  process.env.PORTABLE_APP_DIR = process.env.TEST_PACKAGE_DIR;
  process.env.PORTABLE_PAYLOAD_DIR = path.join(
    process.env.TEST_PACKAGE_DIR,
    'config',
  );
}
const preset = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
);
const settingFile = path.join(data, 'settings.json');
for (const f of [settingFile, settingFile + '.bak']) {
  if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  fs.writeFileSync(f, JSON.stringify(preset));
  fs.chmodSync(f, 0o444);
}
require(
  process.env.TEST_PACKAGE_DIR
    ? path.join(process.env.TEST_PACKAGE_DIR, 'resources/app.asar/src/main.cjs')
    : '../src/main.cjs',
);
let window;
async function js(script) {
  return window.webContents.executeJavaScript(script, true);
}
async function until(script, timeout = 120000) {
  const begin = Date.now();
  while (Date.now() - begin < timeout) {
    if (await js(script)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    'Native Electron assertion timed out: ' + script.slice(0, 120),
  );
}
async function loaded() {
  if (window.webContents.isLoading())
    await new Promise((resolve) =>
      window.webContents.once('did-finish-load', resolve),
    );
  await until(
    "typeof window.portable==='object' && document.getElementById('model-label').options.length>=5",
    20000,
  );
}
app
  .whenReady()
  .then(async () => {
    window = BrowserWindow.getAllWindows()[0];
    assert.ok(window);
    await loaded();
    await js(
      "if(document.getElementById('onboarding').open)document.getElementById('onboarding-close').click()",
    );
    await js('window.portable.saveSettings({fastMode:true})');
    await js('window.portable.saveSettings({fastMode:true})');
    const work = path.join(out, '中文 工作目录');
    fs.mkdirSync(work, { recursive: true });
    const chat = await js(
      'window.portable.createChat(' + JSON.stringify(work) + ')',
    );
    window.webContents.reload();
    await loaded();
    await js("document.querySelector('.history-item').click()");
    await until(
      "document.getElementById('directory-label').textContent==='中文 工作目录'",
    );
    const png = fs.readFileSync(
      path.join(root, 'test-output/live/中文 工作目录/输出/测试图片.png'),
    );
    const image = nativeImage.createFromBuffer(png);
    assert.equal(image.isEmpty(), false);
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([png], { type: 'image/png' }),
      }),
    ]);
    assert.ok(
      (await clipboard.read()).some((item) => item.types.includes('image/png')),
    );
    const imported = await js('window.portable.pasteImage()');
    assert.ok(imported?.image);
    assert.ok(fs.existsSync(imported.path));
    assert.equal(nativeImage.createFromPath(imported.path).isEmpty(), false);
    await js("document.getElementById('prompt').focus()");
    window.webContents.paste();
    await until(
      "document.querySelectorAll('.attachment-chip').length===1",
      20000,
    );
    await until(
      "document.querySelector('.attachment-thumbnail').naturalWidth>0",
      20000,
    );
    console.log(
      'Native clipboard, actual paste event, thumbnail and IPC passed',
    );
    await js(
      "document.getElementById('prompt').value='请直接看这张图。如果主要颜色是绿色，只回复 PASTE_GREEN_OK，不运行工具。';document.getElementById('send').click()",
    );
    await until(
      "document.querySelector('.message.assistant')?.textContent.includes('PASTE_GREEN_OK')",
      180000,
    );
    await until(
      "document.getElementById('stop').classList.contains('hidden')",
      30000,
    );
    const history = await js(
      'window.portable.getChat(' + JSON.stringify(chat.id) + ')',
    );
    assert.ok(
      history.messages.find((m) => m.role === 'user').attachments[0].image,
    );
    assert.equal(history.busy, false);
    window.webContents.reload();
    await loaded();
    await js("document.querySelector('.history-item').click()");
    await until(
      "document.querySelector('.user-attachments .attachment-thumbnail')?.naturalWidth>0",
    );
    fs.writeFileSync(
      path.join(out, 'conversation.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const report = {
      passed: true,
      electronVersion: process.versions.electron,
      builtApplication: !!process.env.TEST_PACKAGE_DIR,
      realPreloadIpc: true,
      nativeClipboardImage: true,
      actualPasteEvent: true,
      thumbnailDecoded: true,
      readOnlySettingsRepeatedSave: true,
      realRelayImageUnderstanding: true,
      historyReloadWithImage: true,
      platform: process.platform,
      nativeWindowsRun: false,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('REAL ELECTRON CLIPBOARD AND CHAT PASSED');
  })
  .catch((error) => {
    console.error('ELECTRON SMOKE FAILED:', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
