'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  Store,
  atomicJson,
  readJson,
  redact,
  scanFiles,
  writeCodexConfig,
} = require('../src/core.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-test-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
const settings = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-private-secret',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  webSearch: true,
};
test('history survives restarting; archive preserves data; path traversal rejected', (t) => {
  const dir = temp(t),
    work = path.join(dir, '中文 空格');
  fs.mkdirSync(work);
  const store = new Store(path.join(dir, 'data'), settings);
  const c = store.create(work);
  c.messages.push({ role: 'user', text: '你好' });
  c.busy = true;
  store.save(c);
  const restarted = new Store(store.directory, settings);
  assert.equal(restarted.get(c.id).messages[0].text, '你好');
  assert.equal(restarted.get(c.id).busy, false);
  assert.equal(restarted.list().length, 1);
  assert.throws(() => store.get('../settings'));
  restarted.archive(c.id);
  assert.equal(restarted.list().length, 0);
  assert.ok(
    fs.existsSync(path.join(store.directory, 'archived', c.id + '.json')),
  );
});
test('corrupted state recovers last backup and retains corrupted original', (t) => {
  const f = path.join(temp(t), 'state.json');
  atomicJson(f, { v: 1 });
  atomicJson(f, { v: 2 });
  fs.writeFileSync(f, 'not json');
  assert.deepEqual(readJson(f, null), { v: 1 });
  assert.ok(
    fs.readdirSync(path.dirname(f)).some((f) => f.includes('.recovery-')),
  );
});
test('settings never expose key and preserve it on blank save', (t) => {
  const s = new Store(temp(t), settings);
  assert.equal(s.publicSettings().apiKey, undefined);
  assert.equal(s.publicSettings().hasApiKey, true);
  s.saveSettings({ apiKey: '', model: 'gpt-6.1-sol' });
  assert.equal(s.settings.apiKey, settings.apiKey);
  assert.throws(() => s.saveSettings({ baseUrl: 'javascript:alert(1)' }));
  assert.throws(() =>
    s.saveSettings({ baseUrl: 'https://user:pass@example.com/v1' }),
  );
  assert.equal(s.settings.baseUrl, settings.baseUrl);
});
test('child configuration routes to relay with env auth and full access', (t) => {
  const dir = temp(t);
  writeCodexConfig(dir, settings);
  const text = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  assert.match(text, /sandbox_mode = "danger-full-access"/);
  assert.match(text, /approval_policy = "never"/);
  assert.match(text, /env_key = "PORTABLE_RELAY_API_KEY"/);
  assert.match(text, /requires_openai_auth = false/);
  assert.ok(!text.includes(settings.apiKey));
  assert.match(text, /service_tier = "fast"/);
  assert.match(text, /fast_mode = true/);
  assert.match(text, /model_reasoning_effort = "medium"/);
});
test('Fast defaults on for new and previous settings; opt-out survives restart independently of thinking', (t) => {
  const dir = temp(t);
  atomicJson(path.join(dir, 'settings.json'), settings);
  const s = new Store(dir, settings);
  assert.equal(s.settings.fastMode, true);
  s.saveSettings({ fastMode: false, reasoningEffort: 'high' });
  const again = new Store(dir, settings);
  assert.equal(again.settings.fastMode, false);
  assert.equal(again.settings.reasoningEffort, 'high');
  const home = path.join(dir, 'home');
  writeCodexConfig(home, again.settings);
  const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(text, /service_tier = "default"/);
  assert.match(text, /model_reasoning_effort = "high"/);
});
test('file scan excludes hidden state, dependencies and symlinks', async (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'private.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.secret'), 'x');
  fs.writeFileSync(path.join(dir, '报告.docx'), 'x');
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'external'));
  const files = await scanFiles(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '报告.docx');
});
test('credential removal covers exact key and bearer headers', () => {
  assert.equal(
    redact('token=abc123 Bearer jwt.token.value', ['abc123']),
    'token=[REDACTED] Bearer [REDACTED]',
  );
});
