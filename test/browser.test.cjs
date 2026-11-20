'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { once } = require('node:events');
const { WebSocket } = require('ws');
const { BrowserBridge } = require('../src/browser-bridge.cjs');
const { BrowserCollector, noteKey } = require('../src/browser-collection.cjs');
const { updateProgress } = require('../src/progress.cjs');
const { taskOutcome } = require('../src/workflow.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-test-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
const png = Buffer.alloc(30);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
const urls = [
  'https://www.xiaohongshu.com/explore/abc123?xsec_token=linkToken',
  'https://www.xiaohongshu.com/explore/def456',
];
function task(t) {
  return { id: 'task-a', title: '主题', output: temp(t) };
}
test('loopback bridge rejects website origins and wrong tokens; valid extension can answer and cancel', async (t) => {
  const root = temp(t),
    bridge = new BrowserBridge({
      root,
      port: 0,
      onCall: async (args) => ({ echo: args.tool }),
    });
  t.after(() => bridge.close());
  await bridge.start();
  const endpoint = `http://127.0.0.1:${bridge.port}/call`;
  assert.equal(
    (await fetch(endpoint, { method: 'POST', body: '{}' })).status,
    403,
  );
  const authorization = 'Bearer ' + bridge.token;
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { authorization, Origin: 'https://evil.test' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.deepEqual(
    await (
      await fetch(endpoint, {
        method: 'POST',
        headers: { authorization },
        body: '{"tool":"read"}',
      })
    ).json(),
    { result: { echo: 'read' } },
  );
  const denied = new WebSocket(bridge.pairUrl(), {
    origin: 'https://evil.test',
  });
  denied.on('error', () => {});
  await new Promise((resolve) => denied.once('close', resolve));
  assert.equal(bridge.status().connected, false);
  const socket = new WebSocket(bridge.pairUrl(), {
    origin: 'chrome-extension://' + 'a'.repeat(32),
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.on('message', (raw) => {
    const v = JSON.parse(raw);
    if (v.op === 'read')
      socket.send(
        JSON.stringify({ id: v.id, result: { url: 'https://example.test' } }),
      );
  });
  assert.deepEqual(await bridge.request('chat-a', 'read'), {
    url: 'https://example.test',
  });
  const controller = new AbortController(),
    pending = bridge.request('chat-a', 'hang', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /停止|abort/i);
  assert.equal(bridge.pending.size, 0);
});
test('batch collection checkpoints each page, deduplicates comments and resumes after login without revisiting finished notes', async (t) => {
  const current = task(t);
  let blocked = true,
    opened = [];
  const bridge = {
    request: async (session, op, args) => {
      if (op === 'screenshot') return { data: png.toString('base64') };
      if (op === 'open') {
        opened.push(args.url);
        return {
          title: '主题笔记',
          url: args.url,
          comments: [{ id: '1', text: '同一评论' }],
          gate: args.url === urls[1] && blocked ? 'login' : null,
        };
      }
      return {
        title: '主题笔记',
        url: urls[0],
        comments: [
          { id: '1', text: '同一评论' },
          { id: '2', text: '新增评论' },
        ],
        acted: { moved: true },
        endVisible: true,
      };
    },
  };
  const collector = new BrowserCollector({ bridge });
  await collector.collect({
    task: current,
    session: 'a',
    urls,
    commentPages: 3,
  });
  assert.equal(current.collection.status, 'needs_user');
  assert.equal(current.collection.completed, 1);
  assert.equal(current.collection.comments, 2);
  assert.equal(current.collection.screenshots, 2);
  assert.ok(fs.existsSync(current.collection.checkpoint));
  assert.ok(
    fs.existsSync(path.join(current.output, '小红书采集/采集索引.csv')),
  );
  blocked = false;
  await collector.collect({
    task: current,
    session: 'a',
    urls: [],
    commentPages: 3,
  });
  assert.equal(current.collection.status, 'completed');
  assert.equal(current.collection.completed, 2);
  assert.equal(opened.filter((v) => v === urls[0]).length, 1);
  const content = JSON.parse(
    fs.readFileSync(path.join(current.output, '小红书采集/采集记录.json')),
  );
  assert.equal(content.notes[0].url, urls[0]);
  assert.match(content.scope, /不保证全部/);
});
test('batch cancellation retains saved screenshots and does not advance to another note', async (t) => {
  const current = task(t),
    controller = new AbortController();
  let opens = 0;
  const bridge = {
    request: async (s, op) => {
      if (op === 'open') {
        opens++;
        return { title: '笔记', comments: [] };
      }
      if (op === 'screenshot') return { data: png.toString('base64') };
      controller.abort();
      throw new Error('cancelled');
    },
  };
  await assert.rejects(
    new BrowserCollector({ bridge }).collect({
      task: current,
      session: 'a',
      urls,
      signal: controller.signal,
    }),
    /停止/,
  );
  assert.equal(opens, 1);
  assert.equal(current.collection.status, 'stopped');
  assert.equal(current.collection.screenshots, 1);
});
test('failed browser calls pause after one attempt and outcome reports partial completion', async (t) => {
  const current = task(t);
  let calls = 0;
  const bridge = {
    request: async () => {
      calls++;
      throw new Error('页面超时');
    },
  };
  await new BrowserCollector({ bridge }).collect({
    task: current,
    session: 'a',
    urls,
  });
  assert.equal(calls, 1);
  assert.equal(current.collection.status, 'paused');
  assert.equal(taskOutcome(current, 'completed'), '部分完成');
  assert.throws(() => noteKey('https://evil.test/explore/abc'));
  assert.throws(() => noteKey('file:///etc/passwd'));
  assert.equal(noteKey(urls[0]), 'abc123');
});
test('plans and live output reach the current task and secrets are removed from progress', () => {
  const chat = {
    tasks: [{ id: 'new' }],
    activity: [{ id: 'cmd', output: '' }],
  };
  assert.equal(
    updateProgress(chat, 'turn/plan/updated', {
      plan: [{ step: '收集帖子', status: 'in_progress' }],
    }),
    true,
  );
  updateProgress(
    chat,
    'item/commandExecution/outputDelta',
    { itemId: 'cmd', delta: 'saved 3 files SECRET' },
    ['SECRET'],
  );
  assert.ok(!JSON.stringify(chat).includes('SECRET'));
  assert.match(chat.tasks[0].progress.detail, /saved 3 files/);
  updateProgress(chat, 'item/completed', {
    item: { type: 'commandExecution', exitCode: 1, aggregatedOutput: 'failed' },
  });
  assert.equal(chat.tasks[0].progress.errors, 1);
  assert.equal(chat.tasks[0].progress.plan[0].step, '收集帖子');
});

test('resuming a stopped note restores the last screen and keeps earlier screenshots', async (t) => {
  const current = task(t),
    controller = new AbortController();
  let first = true,
    position = 0;
  const restored = [];
  const snapshot = () => ({
    title: '笔记',
    position,
    comments: [{ id: 'c' + position, text: '评论' + position }],
    endVisible: position >= 600,
    acted: { moved: true },
  });
  const bridge = {
    request: async (s, op, args) => {
      if (op === 'open') {
        position = 0;
        return snapshot();
      }
      if (op === 'screenshot') return { data: png.toString('base64') };
      if (first) {
        first = false;
        controller.abort();
        throw new Error('cancelled');
      }
      if (Number.isFinite(args.position)) {
        position = args.position;
        restored.push(position);
      } else position += 300;
      return snapshot();
    },
  };
  const collector = new BrowserCollector({ bridge });
  await assert.rejects(
    collector.collect({
      task: current,
      session: 'a',
      urls: [urls[0]],
      commentPages: 3,
      signal: controller.signal,
    }),
    /停止/,
  );
  assert.equal(current.collection.screenshots, 1);
  await collector.collect({
    task: current,
    session: 'a',
    urls: [],
    commentPages: 3,
  });
  assert.deepEqual(restored, [0]);
  assert.equal(current.collection.screenshots, 3);
  assert.equal(current.collection.status, 'completed');
  assert.ok(
    fs.existsSync(
      path.join(current.output, '小红书采集/笔记-abc123/帖子及首屏.png'),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(current.output, '小红书采集/笔记-abc123/评论-02.png'),
    ),
  );
});
