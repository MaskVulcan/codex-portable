'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/inheritance-boot');
fs.mkdirSync(out, { recursive: true });
const versions = path.join(out, 'versions');
fs.rmSync(versions, { recursive: true, force: true });
fs.mkdirSync(versions);
const old = path.join(versions, 'Codex-Portable-1.1.0-win-x64'),
  data = path.join(old, 'data');
fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
const preset = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(preset));
fs.mkdirSync(path.join(data, 'attachments'));
const picture = path.join(data, 'attachments/screenshot.png');
fs.copyFileSync(
  path.join(root, 'test-output/live/中文 工作目录/输出/测试图片.png'),
  picture,
);
const id = '12345678-1234-4234-a234-123456789012',
  chat = {
    id,
    title: '自动继承的对话',
    threadId: null,
    directory: out,
    createdAt: 1,
    updatedAt: 2,
    busy: false,
    messages: [
      {
        id: 'old-user',
        role: 'user',
        text: '我的记录',
        attachments: [{ name: 'screenshot.png', path: picture, image: true }],
      },
    ],
    activity: [],
  };
fs.writeFileSync(
  path.join(data, 'conversations', id + '.json'),
  JSON.stringify(chat),
);
fs.mkdirSync(path.join(data, 'codex-home'));
const db = new DatabaseSync(path.join(data, 'codex-home/memories_1.sqlite'));
db.exec(
  "CREATE TABLE memory(id TEXT PRIMARY KEY,value TEXT); INSERT INTO memory VALUES('test','PRESERVED_MEMORY')",
);
db.close();
const current = path.join(versions, 'Codex-Portable-1.1.1-win-x64');
fs.mkdirSync(current);
process.env.PORTABLE_APP_DIR = current;
process.env.PORTABLE_DATA_DIR = path.join(current, 'data');
process.env.PORTABLE_PAYLOAD_DIR = process.env.TEST_PACKAGE_DIR
  ? path.join(process.env.TEST_PACKAGE_DIR, 'config')
  : path.join(root, 'payload');
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
require(
  process.env.TEST_PACKAGE_DIR
    ? path.join(process.env.TEST_PACKAGE_DIR, 'resources/app.asar/src/main.cjs')
    : '../src/main.cjs',
);
let main;
async function waitFor(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Inheritance startup timed out');
}
app
  .whenReady()
  .then(async () => {
    await waitFor(() => {
      main = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'Codex Portable',
      );
      return !!main;
    });
    if (main.webContents.isLoading())
      await new Promise((r) => main.webContents.once('did-finish-load', r));
    const js = (code) => main.webContents.executeJavaScript(code, true);
    await js(
      "if(document.getElementById('onboarding').open)document.getElementById('onboarding-close').click()",
    );
    const initial = await js('window.portable.initialize()');
    assert.equal(initial.inheritance.newlyImported, true);
    assert.equal(initial.inheritance.sourceCount, 1);
    assert.equal(initial.chats.length, 1);
    assert.equal(initial.chats[0].title, chat.title);
    const restored = await js(
      'window.portable.getChat(' + JSON.stringify(id) + ')',
    );
    assert.ok(fs.existsSync(restored.messages[0].attachments[0].path));
    assert.ok(
      restored.messages[0].attachments[0].path.startsWith(
        path.join(current, 'data'),
      ),
    );
    const merged = new DatabaseSync(
      path.join(current, 'data/codex-home/memories_1.sqlite'),
      { readOnly: true },
    );
    assert.equal(
      merged.prepare('select value from memory where id=?').get('test').value,
      'PRESERVED_MEMORY',
    );
    merged.close();
    assert.equal(
      BrowserWindow.getAllWindows().some(
        (w) => w.getTitle() === '正在继承旧版记录',
      ),
      false,
    );
    assert.ok(fs.existsSync(path.join(old, 'data/settings.json')));
    await waitFor(() =>
      js(
        "document.getElementById('history').textContent.includes('自动继承的对话')",
      ),
    );
    fs.writeFileSync(
      path.join(out, 'inherited.png'),
      (await main.webContents.capturePage()).toPNG(),
    );
    const report = {
      passed: true,
      realElectronBootstrap: true,
      automaticSiblingScan: true,
      historyVisible: true,
      attachmentsRebased: true,
      sqliteAvailableInElectron: true,
      originalFilesPreserved: true,
      migrationWindowCloses: true,
      builtApplication: !!process.env.TEST_PACKAGE_DIR,
      nativeWindowsRun: false,
      platform: process.platform,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('AUTOMATIC INHERITANCE BOOT PASSED');
  })
  .catch((e) => {
    console.error('INHERITANCE BOOT FAILED:', e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
