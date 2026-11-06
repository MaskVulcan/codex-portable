'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  WorkspaceState,
  abortable,
  failure,
  snapshotInputs,
  newTask,
  taskOutcome,
} = require('../src/workflow.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
test('drafts are isolated per conversation and survive restart with attachments', (t) => {
  const p = temp(t),
    s = new WorkspaceState(p);
  s.saveDraft('chat-a', {
    text: 'A草稿',
    attachments: [{ path: 'C:/a.png', name: 'a.png' }],
  });
  s.saveDraft('chat-b', { text: 'B草稿', attachments: [] });
  const r = new WorkspaceState(p);
  assert.equal(r.draft('chat-a').text, 'A草稿');
  assert.equal(r.draft('chat-a').attachments.length, 1);
  assert.equal(r.draft('chat-b').text, 'B草稿');
  r.clearDraft('chat-a');
  assert.equal(r.draft('chat-b').text, 'B草稿');
});
test('abort interrupts an unresolved connection and consumes its eventual rejection', async () => {
  const c = new AbortController();
  let reject;
  const pending = new Promise((_, j) => (reject = j));
  const work = abortable(pending, c.signal);
  c.abort();
  await assert.rejects(work, /停止/);
  reject(new Error('late connection failure'));
  await new Promise((r) => setImmediate(r));
});
test('different tasks have different result folders and work on copies while originals stay intact', async (t) => {
  const p = temp(t),
    original = path.join(p, '报告.txt');
  fs.writeFileSync(original, 'original');
  const c = { directory: p };
  const a = newTask(c, '润色', [{ name: '报告.txt', path: original }]),
    b = newTask(c, '润色', []);
  assert.notEqual(a.output, b.output);
  const inputs = await snapshotInputs(p, a, [
    { path: original, name: '报告.txt' },
  ]);
  fs.writeFileSync(inputs[0].path, 'changed');
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  assert.equal(fs.readFileSync(inputs[0].originalPath, 'utf8'), 'original');
  assert.ok(inputs[0].path.startsWith(a.output));
});
test('outcomes distinguish an answer, validated files, partial files, cancellation and failure', () => {
  assert.equal(taskOutcome({ artifacts: [] }, 'completed'), '已回答');
  assert.equal(
    taskOutcome({ artifacts: [{ validation: { valid: true } }] }, 'completed'),
    '已生成文件',
  );
  assert.equal(
    taskOutcome({ artifacts: [{ validation: { valid: false } }] }, 'completed'),
    '部分完成',
  );
  assert.equal(taskOutcome({}, 'interrupted'), '已停止');
  assert.equal(taskOutcome({}, 'failed'), '处理失败');
});
test('errors have applicable recovery actions rather than always asking users to edit API settings', () => {
  assert.deepEqual(failure({ code: 'ENOENT', message: 'missing' }).actions, [
    'relocate',
    'retry',
  ]);
  assert.equal(failure(new Error('HTTP 401')).kind, 'auth');
  assert.equal(failure(new Error('HTTP 429')).kind, 'quota');
  assert.equal(failure({ code: 'EBUSY', message: 'occupied' }).kind, 'file');
  assert.ok(failure(new Error('fetch failed')).actions.includes('switch'));
});
