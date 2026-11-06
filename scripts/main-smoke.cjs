'use strict';
// Exercises real Electron main-process handlers and real Codex through a minimal
// Electron host stub. No test-only code is included in the application itself.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output', 'main');
fs.mkdirSync(out, { recursive: true });
process.env.PORTABLE_DATA_DIR = path.join(out, 'data');
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
const handlers = new Map(),
  events = new EventEmitter(),
  opened = [];
let win;
const clipboardPng = fs.readFileSync(
  path.join(root, 'test-output/live/中文 工作目录/输出/测试图片.png'),
);
function imageFrom(bytes) {
  const b = Buffer.from(bytes || []),
    valid =
      b.length >= 24 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return {
    isEmpty: () => !valid,
    getSize: () => ({
      width: valid ? b.readUInt32BE(16) : 0,
      height: valid ? b.readUInt32BE(20) : 0,
    }),
    toPNG: () => b,
    resize() {
      return this;
    },
    toDataURL: () => 'data:image/png;base64,' + b.toString('base64'),
  };
}
const app = new EventEmitter();
Object.assign(app, {
  isPackaged: false,
  setPath() {},
  commandLine: { appendSwitch() {} },
  disableHardwareAcceleration() {},
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  getVersion: () => '1.0.0',
  getPath: () => out,
  quit() {
    app.emit('before-quit');
  },
  exit() {
    throw new Error('Unexpected app exit');
  },
});
class Window extends EventEmitter {
  constructor() {
    super();
    win = this;
    this.webContents = new EventEmitter();
    this.webContents.send = (_, e) => {
      const v = structuredClone(e);
      events.emit('event', v);
    };
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.getURL = () => '';
  }
  loadFile() {}
  setMenu() {}
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  focus() {}
}
const electron = {
  app,
  BrowserWindow: Window,
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  dialog: {
    showErrorBox: (title, text) => {
      throw new Error(title + ': ' + text);
    },
    showOpenDialog: async () => ({ canceled: false, filePaths: [out] }),
    showSaveDialog: async () => ({
      canceled: false,
      filePath: path.join(out, 'export.md'),
    }),
  },
  shell: {
    openPath: async (p) => {
      opened.push(p);
      return '';
    },
    showItemInFolder: (p) => opened.push(p),
    openExternal: async (p) => opened.push(p),
  },
};
electron.nativeImage = {
  createFromBuffer: imageFrom,
  createFromPath: (p) => imageFrom(fs.readFileSync(p)),
};
electron.clipboard = { readImage: () => imageFrom(clipboardPng) };
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return electron;
  return originalLoad.call(this, name, ...args);
};
require('../src/main.cjs');
Module._load = originalLoad;
function invoke(name, ...args) {
  return handlers.get('portable:' + name)({ sender: win.webContents }, ...args);
}
function until(predicate, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.off('event', listen);
      reject(new Error('Timed out waiting for main-process event'));
    }, timeout);
    function listen(e) {
      if (predicate(e)) {
        clearTimeout(timer);
        events.off('event', listen);
        resolve(e);
      }
    }
    events.on('event', listen);
  });
}
(async () => {
  await new Promise((r) => setTimeout(r, 20));
  const init = await invoke('initialize');
  assert.equal(init.settings.apiKey, undefined);
  assert.equal(init.settings.hasApiKey, true);
  const work = path.join(out, '中文 工作文件');
  fs.mkdirSync(work, { recursive: true });
  const chat = await invoke('create-chat', work);
  const { Store } = require('../src/core.cjs');
  const originalSave = Store.prototype.save;
  Store.prototype.save = function (c) {
    if (c.id === chat.id && c.busy)
      throw Object.assign(new Error('INJECTED_SAVE_FAILURE'), {
        code: 'EPERM',
      });
    return originalSave.call(this, c);
  };
  await assert.rejects(
    invoke('send', chat.id, '保存失败回归，不应卡在处理中', []),
    /INJECTED_SAVE_FAILURE/,
  );
  assert.equal((await invoke('get-chat', chat.id)).busy, false);
  Store.prototype.save = originalSave;
  const imported = await invoke(
      'import-image',
      new Uint8Array(clipboardPng),
      'clipboard.png',
    ),
    nativePaste = await invoke('paste-image');
  assert.ok(imported.image && imported.thumbnail);
  assert.ok(nativePaste.image);
  assert.notEqual(imported.path, nativePaste.path);
  assert.deepEqual(fs.readFileSync(imported.path), clipboardPng);
  const source = path.join(root, 'test-output/live/中文 工作目录/输出');
  const files = ['测试报告.docx', '测试报告.pdf'].map((f) =>
    path.join(source, f),
  );
  files.push(imported.path);
  const finished = until(
    (e) =>
      e.type === 'chat' &&
      e.chat.id === chat.id &&
      !e.chat.busy &&
      ['已生成文件', '部分完成', '已回答'].includes(e.chat.status),
  );
  await invoke(
    'send',
    chat.id,
    '当前是 Linux 集成测试。请实际读取附件 DOCX 和 PDF，查看图片，将 DOCX 中文正文和图片的尺寸写入输出目录的「读取验证.txt」。只需读取这些本地文件并写出文本，不要联网或安装软件。完成后提供文件链接。',
    files,
  );
  await finished;
  const task = (await invoke('get-chat', chat.id)).tasks.at(-1);
  const result = path.join(task.output, '读取验证.txt');
  assert.ok(fs.statSync(result).size > 0);
  const content = fs.readFileSync(result, 'utf8');
  assert.ok(content.includes('便携助手验证成功'));
  await invoke('open', result.replace(/ /g, '%20'), chat.id);
  assert.equal(opened.at(-1), result);
  const exported = await invoke('export-chat', chat.id);
  assert.ok(fs.readFileSync(exported, 'utf8').includes('Codex'));
  const secondFinished = until(
    (e) =>
      e.type === 'chat' &&
      e.chat.id === chat.id &&
      !e.chat.busy &&
      e.chat.status === '已生成文件',
  );
  await invoke(
    'send',
    chat.id,
    '请用 Python 在这一次指定的新成果目录中生成「第二次验证.txt」，内容为 SECOND_TASK_OK，不要写入上一次任务目录。',
    [],
  );
  await secondFinished;
  const secondTask = (await invoke('get-chat', chat.id)).tasks.at(-1);
  assert.notEqual(secondTask.output, task.output);
  assert.ok(
    fs
      .readFileSync(path.join(secondTask.output, '第二次验证.txt'), 'utf8')
      .includes('SECOND_TASK_OK'),
  );
  assert.ok(!fs.existsSync(path.join(task.output, '第二次验证.txt')));
  // Cancel a real running turn to verify that the UI stop path is wired.
  const active = until(
    (e) =>
      e.type === 'chat' &&
      e.chat.id === chat.id &&
      e.chat.turnId &&
      e.chat.busy,
    30000,
  );
  await invoke(
    'send',
    chat.id,
    '请先用 Python 等待 30 秒，再回复「完成」。这是停止按钮测试。',
    [],
  );
  await active;
  const stopped = until(
    (e) => e.type === 'chat' && e.chat.id === chat.id && !e.chat.busy,
    30000,
  );
  await invoke('stop', chat.id);
  await stopped;
  assert.equal((await invoke('get-chat', chat.id)).busy, false);
  const report = {
    passed: true,
    checks: [
      'main IPC handlers',
      'private relay auth',
      'clipboard image import and native fallback',
      'save failure clears busy and permits retry',
      'actual DOCX/PDF/pasted image attachments',
      'Python file reading',
      'output link with spaces',
      'history persistence',
      'two successive tasks have isolated outputs',
      'export',
      'interrupt',
    ],
    platform: process.platform,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('MAIN SMOKE PASSED');
})()
  .catch((e) => {
    console.error('MAIN SMOKE FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    const { Store } = require('../src/core.cjs'),
      saved = Store.prototype.save;
    Store.prototype.save = () => {
      throw new Error('INJECTED_QUIT_SAVE_FAILURE');
    };
    try {
      app.quit();
      console.log('Shutdown save failure does not escape');
    } finally {
      Store.prototype.save = saved;
    }
  });
