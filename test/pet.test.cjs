'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { EventEmitter } = require('node:events');
const {
  companionState,
  normalizePetSettings,
  boundedPosition,
} = require('../src/pet-state.cjs');
const { PetController } = require('../src/pet-controller.cjs');
test('task pet prioritizes user questions, failed and unread completed tasks before running tasks', () => {
  const chats = [
    {
      id: 'a',
      title: '任务 A',
      busy: true,
      status: '正在处理文件',
      directory: 'A',
      activity: [{ type: 'commandExecution' }],
    },
    { id: 'b', title: '任务 B', busy: false, directory: 'B' },
  ];
  assert.equal(companionState({ chats, activeChatId: 'a' }).state, 'working');
  const notices = [{ chatId: 'b', status: 'ready' }];
  assert.equal(
    companionState({ chats, notices, activeChatId: 'a' }).state,
    'ready',
  );
  notices.push({ chatId: 'b', status: 'blocked' });
  assert.equal(companionState({ chats, notices }).state, 'blocked');
  assert.equal(
    companionState({ chats, notices, questions: ['a'] }).state,
    'needsInput',
  );
  assert.equal(
    companionState({ chats: [], maintenance: true }).state,
    'working',
  );
  assert.equal(companionState({ chats: [] }).state, 'idle');
});
test('pet preferences clamp scale and ignore invalid coordinates while preserving quiet mode', () => {
  const settings = normalizePetSettings({
    enabled: false,
    quiet: true,
    scale: 100,
    position: { x: Infinity, y: 1 },
    notifications: 'yes',
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.quiet, true);
  assert.equal(settings.scale, 1.4);
  assert.equal(settings.position, null);
  assert.equal(settings.notifications, true);
  assert.equal(normalizePetSettings({ scale: -1 }).scale, 0.7);
  assert.deepEqual(
    normalizePetSettings({ position: { x: 25.4, y: -50.6 } }).position,
    { x: 25, y: -51 },
  );
});
test('offscreen position after a disconnected monitor is brought back into visible work area', () => {
  const areas = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1280, y: 0, width: 1280, height: 1024 },
  ];
  assert.deepEqual(
    boundedPosition({ x: 4000, y: 2000, width: 300, height: 270 }, areas),
    { x: 1620, y: 810, width: 300, height: 270 },
  );
  assert.equal(
    boundedPosition({ x: -1100, y: 200, width: 300, height: 270 }, areas).x,
    -1100,
  );
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(),
    sent = [],
    opened = [],
    chats = [
      {
        id: 'chat-a',
        title: '报告',
        directory: root,
        busy: false,
        messages: [],
        activity: [],
      },
    ];
  const electron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    screen: {
      getAllDisplays: () => [
        { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      ],
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
  };
  const controller = new PetController({
    electron,
    root,
    assetsDirectory: root,
    getContext: () => ({
      chats,
      active: chats[0],
      activeChatId: chats[0].id,
      questions: [],
    }),
    onOpenChat: (id) => opened.push(id),
    onDescribeFiles: async (files) =>
      files.map((p) => ({ path: p, name: path.basename(p) })),
    log: () => {},
  });
  controller.window = {
    webContents: {
      isDestroyed: () => false,
      send: (channel, event) => sent.push({ channel, event }),
    },
    isDestroyed: () => false,
  };
  controller.register();
  return { root, controller, handlers, sent, opened, chats };
}
test('pet IPC rejects unrelated windows and never exposes raw connection settings or credentials', async (t) => {
  const f = fixture(t),
    init = f.handlers.get('pet:init');
  await assert.rejects(init({ sender: {} }), /无效/);
  const value = await init({ sender: f.controller.window.webContents });
  assert.equal(value.modelUrl, 'petassets://local/bongo/cat.model3.json');
  assert.equal(value.state.apiKey, undefined);
  assert.equal(value.state.settings.enabled, true);
});
test('completion notices deduplicate, respect quiet mode and disappear after opening their task', (t) => {
  const f = fixture(t),
    chat = {
      ...f.chats[0],
      status: '已完成',
      updatedAt: 123,
      messages: [{ role: 'assistant', text: '已写入文件' }],
    };
  f.controller.settings.quiet = true;
  f.controller.taskFinished(chat);
  f.controller.taskFinished(chat);
  assert.equal(f.controller.status().noticeCount, 1);
  assert.equal(f.controller.status().state, 'ready');
  f.controller.acknowledge(chat.id);
  assert.equal(f.controller.status().noticeCount, 0);
});
test('files dropped on the pet are validated and passed exactly once to quick chat', async (t) => {
  const f = fixture(t);
  f.controller.showQuick = () => {};
  const invoke = (name, ...args) =>
    f.handlers.get('pet:' + name)(
      { sender: f.controller.window.webContents },
      ...args,
    );
  await invoke('attach-drop', ['/work/报告.docx']);
  assert.equal((await invoke('take-files')).length, 1);
  assert.equal((await invoke('take-files')).length, 0);
});
