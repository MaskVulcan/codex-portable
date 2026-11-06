'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  Module = require('node:module'),
  { EventEmitter } = require('node:events'),
  assert = require('node:assert/strict');
const { CodexRpc } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/usability');
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'data');
fs.rmSync(data, { recursive: true, force: true });
process.env.PORTABLE_DATA_DIR = data;
process.env.PORTABLE_APP_DIR = path.join(out, 'app');
process.env.PORTABLE_PAYLOAD_DIR = path.join(root, 'payload');
process.env.PORTABLE_CODEX_EXE = require('./test-env.cjs').codex;
process.env.PORTABLE_PYTHON_EXE = require('./test-env.cjs').python;
const handlers = new Map(),
  events = new EventEmitter(),
  started = [],
  answers = [];
let win,
  delayStart = false,
  pendingStart,
  delayedThread = null,
  calls = 0;
class Child extends EventEmitter {
  constructor() {
    super();
    this.pid = 123;
    this.exitCode = null;
    this.signalCode = null;
  }
}
const originals = {
  start: CodexRpc.prototype.start,
  request: CodexRpc.prototype.request,
  close: CodexRpc.prototype.close,
};
CodexRpc.prototype.start = async function () {
  this.process = new Child();
  if (delayStart)
    await new Promise((r, j) => (pendingStart = { resolve: r, reject: j }));
  return this;
};
CodexRpc.prototype.close = function () {
  const c = this.process;
  this.process = null;
  if (c) {
    c.exitCode = 0;
    c.emit('close');
  }
  pendingStart?.reject(new Error('closed'));
};
CodexRpc.prototype.send = function (message) {
  answers.push(message);
};
CodexRpc.prototype.request = async function (method, params) {
  if (method === 'thread/start') {
    const id = 'thread-' + ++calls;
    return { thread: { id } };
  }
  if (method === 'thread/resume') return { thread: { id: params.threadId } };
  if (method === 'turn/start') {
    if (delayedThread) {
      await new Promise((r) => (delayedThread.resolve = r));
    }
    const turn = { id: 'turn-' + ++calls };
    started.push({ client: this, params, turn });
    this.emit('notification', {
      method: 'turn/started',
      params: { threadId: params.threadId, turn },
    });
    return { turn };
  }
  if (method === 'turn/interrupt') {
    this.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: params.threadId,
        turn: { id: params.turnId, status: 'interrupted' },
      },
    });
    return {};
  }
  return {};
};
const app = new EventEmitter();
Object.assign(app, {
  isPackaged: false,
  setPath() {},
  commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  getVersion: () => '1.2.0',
  getPath: () => out,
  quit() {
    app.emit('before-quit');
  },
  exit() {
    throw new Error('Unexpected exit');
  },
});
class Window extends EventEmitter {
  constructor() {
    super();
    win = this;
    this.webContents = new EventEmitter();
    this.webContents.send = (_, e) => events.emit('event', structuredClone(e));
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.getURL = () => '';
  }
  loadFile() {}
  setMenu() {}
  isDestroyed() {
    return false;
  }
}
const selected = path.join(out, 'relocated');
fs.mkdirSync(selected, { recursive: true });
const electron = {
  app,
  BrowserWindow: Window,
  ipcMain: { handle: (n, fn) => handlers.set(n, fn) },
  dialog: {
    showErrorBox: (t, m) => {
      throw new Error(t + ': ' + m);
    },
    showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }),
    showSaveDialog: async () => ({
      canceled: false,
      filePath: path.join(out, 'export-' + Date.now()),
    }),
  },
  shell: { openPath: async () => '' },
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? electron : load.call(this, name, ...args);
};
require('../src/main.cjs');
Module._load = load;
const invoke = (name, ...args) =>
  handlers.get('portable:' + name)({ sender: win.webContents }, ...args);
async function wait(fn, timeout = 5000) {
  const begin = Date.now();
  while (Date.now() - begin < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Regression timeout');
}
(async () => {
  await new Promise((r) => setTimeout(r, 10));
  const a = await invoke('create-chat', out),
    b = await invoke('create-chat', out);
  delayStart = true;
  const cancelled = invoke('send', a.id, '连接阶段取消', []);
  await wait(() => pendingStart);
  await invoke('stop', a.id);
  assert.equal((await invoke('get-chat', a.id)).busy, false);
  const stopped = await cancelled;
  assert.equal(stopped.cancelled, true);
  assert.equal(started.length, 0);
  delayStart = false;
  pendingStart = null;
  await invoke('send', a.id, 'A任务', []);
  const running = started.at(-1);
  running.client.emit('question', {
    id: 71,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: running.params.threadId,
      questions: [
        { id: 'q', question: '输出格式？', options: [{ label: 'Word' }] },
      ],
    },
  });
  await invoke('get-chat', b.id);
  assert.equal((await invoke('pending-questions', a.id)).length, 1);
  assert.equal(
    (await invoke('list-chats')).find((c) => c.id === a.id).pendingQuestions,
    1,
  );
  assert.equal(
    (await invoke('get-chat', a.id)).pendingQuestions[0].requestId,
    71,
  );
  await invoke('answer', 71, { q: { answers: ['Word'] } });
  assert.equal((await invoke('pending-questions', a.id)).length, 0);
  await invoke('stop', a.id);
  await invoke('save-draft', a.id, {
    text: 'A文字',
    attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
  });
  await invoke('save-draft', b.id, { text: 'B文字', attachments: [] });
  assert.equal((await invoke('get-draft', a.id)).attachments.length, 1);
  assert.equal((await invoke('get-draft', b.id)).text, 'B文字');
  const source = path.join(out, '原文.txt');
  fs.writeFileSync(source, 'ORIGINAL');
  await invoke('send', a.id, '改写文件', [source]);
  const task = (await invoke('get-chat', a.id)).tasks.at(-1);
  const original = task.originals[0];
  assert.ok(original.path !== source);
  fs.writeFileSync(original.path, 'TASK COPY CHANGED');
  assert.equal(fs.readFileSync(source, 'utf8'), 'ORIGINAL');
  fs.writeFileSync(path.join(task.output, '结果.txt'), 'DELIVERED');
  const current = started.at(-1);
  current.client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: current.params.threadId,
      turn: { id: current.turn.id, status: 'completed' },
    },
  });
  await wait(async () => !(await invoke('get-chat', a.id)).busy);
  const done = await invoke('get-chat', a.id);
  assert.equal(done.status, '已生成文件');
  assert.equal(done.tasks.at(-1).artifacts.length, 1);
  assert.equal((await invoke('output-files', a.id)).length, 1);
  await invoke('archive-chat', a.id);
  assert.ok((await invoke('list-archived')).some((c) => c.id === a.id));
  await invoke('restore-chat', a.id);
  assert.ok((await invoke('list-chats')).some((c) => c.id === a.id));
  const directory = (await invoke('get-chat', b.id)).directory;
  assert.ok(directory);
  await invoke('relocate-chat', b.id);
  assert.equal((await invoke('get-chat', b.id)).directory, selected);
  await invoke('send', b.id, '普通问题', []);
  const answer = started.at(-1);
  answer.client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: answer.params.threadId,
      turn: { id: answer.turn.id, status: 'completed' },
    },
  });
  await wait(async () => !(await invoke('get-chat', b.id)).busy);
  assert.equal((await invoke('get-chat', b.id)).status, '已回答');
  const report = {
    passed: true,
    cancelDuringConnection: true,
    noLateTurnAfterCancel: true,
    questionsAvailableAcrossConversations: true,
    draftAttachmentsIsolated: true,
    taskOriginalSnapshot: true,
    distinctTaskOutput: true,
    validatedTaskArtifacts: true,
    answerNotClaimedAsFile: true,
    archiveRestore: true,
    relocateExistingConversation: true,
    platform: process.platform,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('USABILITY MAIN REGRESSION PASSED');
})()
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    Object.assign(CodexRpc.prototype, originals);
  });
