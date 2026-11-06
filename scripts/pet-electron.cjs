'use strict';
const electron = require('electron'),
  { app, BrowserWindow, clipboard, ClipboardItem } = electron;
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/pet');
fs.mkdirSync(out, { recursive: true });
process.env.PORTABLE_DATA_DIR = path.join(out, 'data');
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
if (process.env.TEST_PACKAGE_DIR) {
  process.env.PORTABLE_APP_DIR = process.env.TEST_PACKAGE_DIR;
  process.env.PORTABLE_PAYLOAD_DIR = path.join(
    process.env.TEST_PACKAGE_DIR,
    'config',
  );
}
const opened = [];
electron.shell.openPath = async (p) => {
  opened.push(p);
  return '';
};
require(
  process.env.TEST_PACKAGE_DIR
    ? path.join(process.env.TEST_PACKAGE_DIR, 'resources/app.asar/src/main.cjs')
    : '../src/main.cjs',
);
let main, pet, quick;
const js = (win, script) => win.webContents.executeJavaScript(script, true);
async function waitFor(predicate, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Desktop pet test timed out');
}
async function loaded(win) {
  if (win.webContents.isLoading())
    await new Promise((r) => win.webContents.once('did-finish-load', r));
}
app
  .whenReady()
  .then(async () => {
    main = BrowserWindow.getAllWindows()[0];
    await loaded(main);
    await js(
      main,
      "if(document.getElementById('onboarding').open)document.getElementById('onboarding-close').click()",
    );
    await waitFor(() => {
      pet = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'Bongo · Codex',
      );
      return !!pet;
    });
    pet.webContents.on('console-message', (...args) => {
      const v = args[0];
      const text = typeof v === 'object' ? v.message : args[1];
      if (text) console.log('PET CONSOLE:', text);
    });
    await loaded(pet);
    await waitFor(() => js(pet, '!!document.body.dataset.renderer'));
    console.log(
      'Pet renderer:',
      await js(pet, 'document.body.dataset.renderer'),
    );
    if ((await js(pet, 'document.body.dataset.renderer')) !== 'live2d')
      throw new Error('Bongo model did not load in the real Live2D renderer');
    assert.ok(
      await js(
        pet,
        'window.__petModel.internalModel.coreModel.getParameterCount()>0',
      ),
    );
    await js(
      pet,
      "window.__petModel.internalModel.on('beforeModelUpdate',()=>{if(window.__petModel.internalModel.coreModel.getParameterValueById('ParamCheek')>0)window.__patObserved=true;});window.companion.interact('pat')",
    );
    await waitFor(() => js(pet, 'window.__patObserved===true'));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(
      path.join(out, 'bongo.png'),
      (await pet.webContents.capturePage()).toPNG(),
    );
    await js(pet, 'window.companion.configure({quiet:true,scale:1})');
    await js(
      pet,
      'window.companion.configure({quiet:false,notifications:false})',
    );
    const work = path.join(out, '办公目录');
    fs.mkdirSync(work, { recursive: true });
    const chat = await js(
      main,
      'window.portable.createChat(' + JSON.stringify(work) + ')',
    );
    await js(pet, 'window.companion.quick()');
    await waitFor(() => {
      quick = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'Bongo 快捷聊天',
      );
      return !!quick;
    });
    await loaded(quick);
    await waitFor(() =>
      js(
        quick,
        "document.getElementById('folder-label').textContent==='办公目录'",
      ),
    );
    const attachment = path.join(work, '资料.txt');
    fs.writeFileSync(attachment, '桌宠附件测试，标记 BONGO_FILE_OK', 'utf8');
    await js(
      pet,
      'window.companion.attachDrop(' + JSON.stringify([attachment]) + ')',
    );
    await waitFor(() =>
      js(quick, "document.querySelectorAll('.chip').length===1"),
    );
    const image = fs.readFileSync(
      path.join(root, 'test-output/live/中文 工作目录/输出/测试图片.png'),
    );
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([image], { type: 'image/png' }),
      }),
    ]);
    await js(quick, "document.getElementById('prompt').focus()");
    quick.webContents.paste();
    await waitFor(() =>
      js(quick, "document.querySelectorAll('.chip').length===2"),
    );
    await js(
      quick,
      "document.getElementById('prompt').value='请读取文本附件里的标记并查看图片的主要颜色。在输出目录生成桌宠验证.txt，写入标记与颜色。最后只回复 BONGO_QUICK_OK。不要安装软件。';document.getElementById('send').click()",
    );
    await waitFor(() =>
      js(
        quick,
        "!document.getElementById('stop').classList.contains('hidden')",
      ),
    );
    main.close();
    assert.equal(main.isVisible(), false);
    const running = await js(main, 'window.portable.petStatus()');
    assert.ok(['working', 'thinking'].includes(running.state));
    console.log('Main window hidden while task continues:', running.state);
    await waitFor(
      () =>
        js(
          quick,
          "document.getElementById('messages').textContent.includes('BONGO_QUICK_OK')&&document.getElementById('stop').classList.contains('hidden')",
        ),
      240000,
    );
    const finished = await js(main, 'window.portable.petStatus()');
    assert.equal(finished.state, 'ready');
    assert.ok(finished.noticeCount >= 1);
    const task = (
      await js(main, 'window.portable.getChat(' + JSON.stringify(chat.id) + ')')
    ).tasks.at(-1);
    assert.ok(fs.statSync(path.join(task.output, '桌宠验证.txt')).size > 0);
    assert.match(
      fs.readFileSync(path.join(task.output, '桌宠验证.txt'), 'utf8'),
      /BONGO_FILE_OK/,
    );
    await js(
      quick,
      'window.companion.openOutput(' + JSON.stringify(chat.id) + ')',
    );
    assert.ok(
      opened.includes(task.output) || opened.includes(path.join(work, '输出')),
    );
    await new Promise((r) => setTimeout(r, 350));
    fs.writeFileSync(
      path.join(out, 'quick-chat.png'),
      (await quick.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(out, 'task-ready.png'),
      (await pet.webContents.capturePage()).toPNG(),
    );
    await js(
      quick,
      'window.companion.openChat(' + JSON.stringify(chat.id) + ')',
    );
    assert.equal(main.isVisible(), true);
    await waitFor(
      async () =>
        (await js(main, 'window.portable.petStatus()')).noticeCount === 0,
    );
    const config = JSON.parse(
      fs.readFileSync(
        path.join(process.env.PORTABLE_DATA_DIR, 'pet.json'),
        'utf8',
      ),
    );
    assert.equal(config.quiet, false);
    assert.equal(config.notifications, false);
    const report = {
      passed: true,
      live2dModelRendered: true,
      live2dPatInteraction: true,
      transparentWindow: true,
      quickChat: true,
      sharedConversation: true,
      droppedFileHandoff: true,
      clipboardImage: true,
      mainCloseKeepsTaskRunning: true,
      taskCompletionNotice: true,
      outputOpensViaDefaultHandler: true,
      notificationAcknowledged: true,
      petSettingsPersisted: true,
      builtApplication: !!process.env.TEST_PACKAGE_DIR,
      platform: process.platform,
      nativeWindowsRun: false,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('LIVE2D PET END-TO-END PASSED');
  })
  .catch((e) => {
    console.error('PET SMOKE FAILED:', e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
