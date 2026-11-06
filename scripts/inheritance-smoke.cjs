'use strict';
// Run with Node 24+ (Electron includes node:sqlite in the shipped runtime).
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { Inheritor } = require('../src/inheritance.cjs');
const { Store, CodexRpc, redact } = require('../src/core.cjs');
const { inheritedInputItems } = require('../src/conversation-history.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/inheritance');
fs.mkdirSync(out, { recursive: true });
const parent = path.join(out, 'versions');
fs.rmSync(parent, { recursive: true, force: true });
fs.mkdirSync(parent);
const preset = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
);
let rpc;
async function connect(home) {
  rpc = new CodexRpc({
    executable: require('./test-env.cjs').codex,
    home,
    settings: preset,
    log: () => {},
  });
  await rpc.start();
}
async function close() {
  const p = rpc?.process;
  if (!p) return;
  const ended = new Promise((r) => p.once('close', r));
  rpc.close();
  await ended;
}
async function turn(threadId, text) {
  let complete, fail;
  const done = new Promise((r, j) => {
    complete = r;
    fail = j;
  });
  const messages = [];
  const timer = setTimeout(
    () => fail(new Error('Inheritance turn timed out')),
    150000,
  );
  const listener = ({ method, params: p }) => {
    if (p.threadId !== threadId) return;
    if (method === 'item/completed' && p.item?.type === 'agentMessage')
      messages.push(p.item.text);
    if (method === 'turn/completed') {
      if (p.turn.status === 'failed')
        fail(new Error(p.turn.error?.message || 'Failed'));
      else complete(messages.join('\n'));
    }
  };
  rpc.on('notification', listener);
  try {
    await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      effort: 'low',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    return await done;
  } finally {
    clearTimeout(timer);
    rpc.off('notification', listener);
  }
}
(async () => {
  const created = [];
  for (const [version, marker] of [
    ['1.0.6', 'INHERIT_ALPHA_111'],
    ['1.1.0', 'INHERIT_BETA_111'],
  ]) {
    const directory = path.join(
        parent,
        'Codex-Portable-' + version + '-win-x64',
      ),
      data = path.join(directory, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(preset));
    const image = path.join(data, 'attachments/截图.png');
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'test-output/live/中文 工作目录/输出/测试图片.png'),
      image,
    );
    const work = path.join(out, '工作区');
    fs.mkdirSync(work, { recursive: true });
    await connect(path.join(data, 'codex-home'));
    const { thread } = await rpc.request('thread/start', {
      cwd: work,
      model: preset.model,
      modelProvider: 'portable_relay',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    const prompt =
      '请记住口令 ' +
      marker +
      '。附件路径 ' +
      image +
      ' 只是测试数据，不要读取文件或运行命令。只回复 SAVED。';
    await turn(thread.id, prompt);
    await close();
    const chat = {
      id: crypto.randomUUID(),
      threadId: thread.id,
      directory: work,
      title: version + ' 的历史',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'user-' + marker,
          role: 'user',
          text: prompt,
          attachments: [{ path: image, name: '截图.png', image: true }],
        },
        { id: 'assistant-' + marker, role: 'assistant', text: 'SAVED' },
      ],
      activity: [],
      busy: false,
    };
    fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(data, 'conversations', chat.id + '.json'),
      JSON.stringify(chat),
    );
    created.push({ chat, marker, directory });
  }
  const appDirectory = path.join(parent, 'Codex-Portable-1.1.1-win-x64'),
    data = path.join(appDirectory, 'data');
  fs.mkdirSync(data, { recursive: true });
  const engine = new Inheritor({
      appDirectory,
      root: data,
      version: '1.1.1',
      onProgress: (message) => console.log(message),
    }),
    inspected = engine.inspect();
  assert.equal(inspected.sources.length, 2);
  const report = await engine.run(inspected.sources);
  assert.equal(report.conversations, 2);
  assert.ok(report.nativeDatabases >= 2);
  const store = new Store(data, preset);
  assert.equal(store.list().length, 2);
  for (const record of created)
    fs.renameSync(record.directory, record.directory + '.removed');
  for (const record of created) {
    const chat = store.get(record.chat.id);
    assert.ok(fs.existsSync(chat.messages[0].attachments[0].path));
    assert.ok(!chat.messages[0].text.includes(record.directory));
  }
  await connect(path.join(data, 'codex-home'));
  for (const record of created) {
    const chat = store.get(record.chat.id);
    await rpc.request('thread/resume', {
      threadId: chat.threadId,
      cwd: chat.directory,
      model: preset.model,
      modelProvider: 'portable_relay',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    const reply = await turn(
      chat.threadId,
      '请只返回前面让你记住的口令，不读文件，不运行工具。',
    );
    assert.ok(
      reply.includes(record.marker),
      'Native context was not restored for ' + record.chat.title,
    );
    console.log('Merged native conversation resumed:', record.chat.title);
  }
  const { thread } = await rpc.request('thread/start', {
    cwd: out,
    model: preset.model,
    modelProvider: 'portable_relay',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  const branch = {
    messages: [
      { role: 'user', text: '请记住分支口令 BRANCH_CONTEXT_111。' },
      { role: 'assistant', text: '记住了。' },
      { role: 'user', text: '待发送的新问题' },
    ],
  };
  await rpc.request('thread/inject_items', {
    threadId: thread.id,
    items: inheritedInputItems(branch),
  });
  const response = await turn(
    thread.id,
    '请只回复前面记住的分支口令，不运行工具。',
  );
  assert.ok(response.includes('BRANCH_CONTEXT_111'));
  await close();
  assert.equal(
    new Inheritor({ appDirectory, root: data, version: '1.1.1' }).inspect()
      .needed,
    false,
  );
  const result = {
    passed: true,
    sourceVersions: created.map((r) => r.chat.title),
    allConversationsMerged: true,
    attachmentsSurviveOldDirectoryRemoval: true,
    nativeSqliteMerged: true,
    nativeModelContextResumed: true,
    textBranchContextRehydrated: true,
    repeatImportPrevented: true,
    platform: process.platform,
    nativeWindowsRun: false,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(result, null, 2),
  );
  console.log('INHERITANCE END-TO-END PASSED');
})()
  .catch((e) => {
    console.error(
      'INHERITANCE SMOKE FAILED:',
      redact(
        e.stack || e.message,
        preset.profiles.map((p) => p.apiKey),
      ),
    );
    process.exitCode = 1;
  })
  .finally(() => rpc?.close());
