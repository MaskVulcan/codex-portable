'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  Inheritor,
  findPreviousInstallations,
} = require('../src/inheritance.cjs');
const { atomicJson } = require('../src/persistence.cjs');
const { Store } = require('../src/core.cjs');
const { configurePythonOverlay } = require('../src/runtime.cjs');
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'inheritance-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const appDirectory = path.join(parent, 'Codex-Portable-1.1.1-win-x64'),
    root = path.join(appDirectory, 'data');
  fs.mkdirSync(root, { recursive: true });
  return { parent, appDirectory, root, version: '1.1.1' };
}
const profile = {
  id: 'relay-default',
  name: 'axhan',
  baseUrl: 'https://relay.example/v1',
  apiKey: 'TEST_CREDENTIAL',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'xhigh',
  fastMode: true,
};
function old(f, version, name) {
  const directory = path.join(
      f.parent,
      name || 'Codex-Portable-' + version + '-win-x64',
    ),
    data = path.join(directory, 'data');
  fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
  atomicJson(path.join(data, 'settings.json'), {
    ...profile,
    profiles: [profile],
    activeProfileId: profile.id,
    lastDirectory: 'D:\\办公资料',
  });
  return { directory, data, version };
}
function chat(id, text, time = 100) {
  return {
    id,
    title: text,
    directory: 'D:\\办公资料',
    threadId: null,
    createdAt: 1,
    updatedAt: time,
    busy: false,
    messages: [{ id: 'msg-' + id, role: 'user', text }],
    activity: [],
  };
}
function writeChat(s, c, folder = 'conversations') {
  atomicJson(path.join(s.data, folder, c.id + '.json'), c);
}
async function migrate(f) {
  const engine = new Inheritor(f),
    inspect = engine.inspect();
  assert.equal(inspect.needed, true);
  return engine.run(inspect.sources);
}
test('finds sibling and doubly nested versions while excluding unrelated, newer and symbolic directories', (t) => {
  const f = fixture(t),
    a = old(f, '1.0.6'),
    outer = path.join(f.parent, 'Codex-Portable-1.1.0-win-x64');
  fs.mkdirSync(outer);
  const b = old({ ...f, parent: outer }, '1.1.0');
  old(f, '9.0.0');
  old(f, '0.0.0', 'another-app');
  fs.symlinkSync(
    a.directory,
    path.join(f.parent, 'Codex-Portable-1.0.5-win-x64'),
  );
  const result = findPreviousInstallations(f.appDirectory, f.root, f.version);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.directory === b.directory));
  assert.ok(!result.some((r) => r.version === '9.0.0'));
});
test('merges every conversation, deduplicates shared history and images, and repairs internal attachment paths', async (t) => {
  const f = fixture(t),
    a = old(f, '1.0.6'),
    b = old(f, '1.1.0');
  const id = '11111111-1111-4111-a111-111111111111',
    one = chat(id, '第一条', 100),
    newer = structuredClone(one);
  newer.messages.push({ id: 'second', role: 'assistant', text: '已经完成' });
  newer.updatedAt = 200;
  for (const [source, conversation] of [
    [a, one],
    [b, newer],
  ]) {
    const picture = path.join(source.data, 'attachments/picture.png');
    fs.mkdirSync(path.dirname(picture), { recursive: true });
    fs.writeFileSync(picture, 'same image bytes');
    conversation.messages[0].attachments = [
      { name: 'picture.png', path: picture, image: true },
    ];
    writeChat(source, conversation);
  }
  writeChat(a, chat('22222222-2222-4222-a222-222222222222', '独立历史'));
  writeChat(
    b,
    chat('33333333-3333-4333-a333-333333333333', '归档历史'),
    'archived',
  );
  atomicJson(path.join(b.data, 'pet.json'), { quiet: true, enabled: false });
  const report = await migrate(f);
  assert.equal(report.conversations, 2);
  assert.equal(report.archived, 1);
  assert.equal(report.attachments, 1);
  const store = new Store(f.root, profile);
  const inherited = store.get(id);
  assert.equal(inherited.messages.length, 2);
  assert.equal(
    fs.readFileSync(inherited.messages[0].attachments[0].path, 'utf8'),
    'same image bytes',
  );
  assert.ok(inherited.messages[0].attachments[0].path.startsWith(f.root));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, 'pet.json'))).quiet,
    true,
  );
  fs.rmSync(a.directory, { recursive: true, force: true });
  fs.rmSync(b.directory, { recursive: true, force: true });
  assert.ok(fs.existsSync(inherited.messages[0].attachments[0].path));
  assert.equal(new Inheritor(f).inspect().needed, false);
});
test('divergent copies of a conversation preserve a separate visible branch with resumable text history', async (t) => {
  const f = fixture(t),
    a = old(f, '1.0.6'),
    b = old(f, '1.1.0'),
    id = '11111111-1111-4111-a111-111111111111';
  const one = chat(id, '分支 A', 100),
    two = chat(id, '分支 B', 200);
  one.threadId = 'old-native-thread';
  two.threadId = 'new-native-thread';
  writeChat(a, one);
  writeChat(b, two);
  const report = await migrate(f);
  assert.equal(report.conversations, 2);
  assert.equal(report.branches, 1);
  const store = new Store(f.root, profile),
    all = store.list().map((s) => store.get(s.id));
  assert.ok(all.some((c) => c.messages[0].text === '分支 A'));
  assert.ok(all.some((c) => c.messages[0].text === '分支 B'));
  const branch = all.find((c) => c.inheritedHistory);
  assert.equal(branch.threadId, null);
  assert.equal(branch.inheritedThreadId, 'old-native-thread');
});
test('existing target preferences and all distinct saved relay credentials survive merging', async (t) => {
  const f = fixture(t),
    a = old(f, '1.0.6');
  writeChat(a, chat('11111111-1111-4111-a111-111111111111', '历史'));
  atomicJson(path.join(f.root, 'settings.json'), {
    ...profile,
    profiles: [{ ...profile, apiKey: 'CURRENT_USER_CREDENTIAL' }],
    activeProfileId: profile.id,
    lastDirectory: 'C:\\当前工作',
  });
  await migrate(f);
  const store = new Store(f.root, profile);
  assert.equal(store.settings.apiKey, 'CURRENT_USER_CREDENTIAL');
  assert.equal(store.settings.lastDirectory, 'C:\\当前工作');
  assert.ok(
    store.settings.profiles.some((p) => p.apiKey === 'TEST_CREDENTIAL'),
  );
  const report = JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(f.root, 'inheritance.json'))),
  );
  assert.ok(!report.includes('TEST_CREDENTIAL'));
  assert.ok(!report.includes('CURRENT_USER_CREDENTIAL'));
});
test('a newer complete .tmp message is recovered and an interrupted migration can safely retry', async (t) => {
  const f = fixture(t),
    a = old(f, '1.1.0'),
    c = chat('11111111-1111-4111-a111-111111111111', '旧消息');
  writeChat(a, c);
  const file = path.join(a.data, 'conversations', c.id + '.json');
  fs.utimesSync(file, 1000, 1000);
  c.messages.push({
    id: 'recovered',
    role: 'user',
    text: '未完成保存的新消息',
  });
  c.busy = true;
  fs.writeFileSync(file + '.tmp', JSON.stringify(c));
  const broken = path.join(a.data, 'codex-home/state_5.sqlite');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, 'unreadable DB');
  const engine = new Inheritor({
    ...f,
    databaseFactory: class {
      constructor() {
        throw new Error('SIMULATED_INTERRUPTION');
      }
    },
  });
  const inspected = engine.inspect();
  await assert.rejects(engine.run(inspected.sources), /SIMULATED_INTERRUPTION/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, 'inheritance.json')))
      .completed,
    false,
  );
  fs.rmSync(broken);
  const result = await migrate(f);
  assert.equal(result.completed, true);
  const stored = new Store(f.root, profile).get(c.id);
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.busy, false);
  assert.equal(new Inheritor(f).inspect().needed, false);
});
test('extra pip packages are copied as a small overlay without copying bundled Python or changing old files', async (t) => {
  const f = fixture(t),
    a = old(f, '1.1.0');
  writeChat(a, chat('11111111-1111-4111-a111-111111111111', '历史'));
  for (const base of [
    path.join(a.directory, 'python'),
    path.join(f.appDirectory, 'python'),
  ]) {
    fs.mkdirSync(path.join(base, 'Lib/site-packages/base_package'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(base, 'python.exe'), 'executable');
    fs.writeFileSync(path.join(base, 'python312._pth'), 'import site');
    fs.writeFileSync(
      path.join(base, 'Lib/site-packages/base_package/__init__.py'),
      'BASE=1',
    );
  }
  const extra = path.join(a.directory, 'python/Lib/site-packages/my_extra');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, '__init__.py'), 'MARKER=123');
  const report = await migrate(f);
  assert.equal(report.pythonExtensions, 1);
  const overlay = path.join(f.root, 'python-packages/my_extra/__init__.py');
  assert.ok(fs.existsSync(overlay));
  assert.equal(fs.existsSync(path.join(f.root, 'runtime/python')), false);
  assert.equal(
    fs.existsSync(path.join(f.root, 'python-packages/base_package')),
    false,
  );
  configurePythonOverlay(
    path.join(f.appDirectory, 'python/python.exe'),
    f.root,
  );
  const pointer = path.join(
    f.appDirectory,
    'python/Lib/site-packages/codex_portable_inherited.pth',
  );
  assert.match(fs.readFileSync(pointer, 'utf8'), /sys.path.insert/);
  assert.ok(fs.existsSync(path.join(extra, '__init__.py')));
});
test('no previous data marks the first scan complete and later launches do not import unexpected folders', (t) => {
  const f = fixture(t),
    engine = new Inheritor(f);
  assert.equal(engine.inspect().needed, false);
  const a = old(f, '1.0.6');
  writeChat(
    a,
    chat('11111111-1111-4111-a111-111111111111', '后来创建的旧目录'),
  );
  assert.equal(new Inheritor(f).inspect().needed, false);
  assert.equal(fs.existsSync(path.join(f.root, 'conversations')), false);
});
test('completed first-start inheritance never enumerates sibling directories again', (t) => {
  const f = fixture(t);
  new Inheritor(f).inspect();
  t.mock.method(fs, 'readdirSync', () => {
    throw new Error('Repeated startup must not scan directories');
  });
  const result = new Inheritor(f).inspect();
  assert.equal(result.needed, false);
  assert.equal(result.report.completed, true);
  assert.equal(result.report.newlyImported, false);
});
test('older modified Python libraries cannot override the most recently used installation', async (t) => {
  const f = fixture(t),
    a = old(f, '1.0.6'),
    b = old(f, '1.1.0');
  writeChat(a, chat('11111111-1111-4111-a111-111111111111', '历史'));
  for (const [base, text] of [
    [path.join(a.directory, 'python'), 'OLD=1'],
    [path.join(b.directory, 'python'), 'NEW=1'],
    [path.join(f.appDirectory, 'python'), 'NEW=1'],
  ]) {
    fs.mkdirSync(path.join(base, 'Lib/site-packages/shared'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(base, 'python.exe'), 'exe');
    fs.writeFileSync(path.join(base, 'python312._pth'), 'import site');
    fs.writeFileSync(
      path.join(base, 'Lib/site-packages/shared/__init__.py'),
      text,
    );
  }
  fs.utimesSync(path.join(b.data, 'settings.json'), 2000000000, 2000000000);
  await migrate(f);
  assert.equal(
    fs.existsSync(path.join(f.root, 'python-packages/shared')),
    false,
  );
});
