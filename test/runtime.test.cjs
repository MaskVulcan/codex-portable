'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { resolveRuntime } = require('../src/runtime.cjs');
const { Store } = require('../src/core.cjs');
function setup(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-portable-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return {
    appDirectory: path.join(p, '中文 程序'),
    dataDirectory: path.join(p, '中文 程序/data'),
  };
}
function file(p, body = 'runtime') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
function seed(p) {
  file(path.join(p.appDirectory, 'codex/bin/codex.exe'));
  file(path.join(p.appDirectory, 'python/python.exe'));
  file(path.join(p.appDirectory, 'scripts/office_tools.py'));
}
test('first and repeated startup use sibling files directly without copying tools or creating a runtime directory', (t) => {
  const p = setup(t);
  seed(p);
  const files = [
    'codex/bin/codex.exe',
    'python/python.exe',
    'scripts/office_tools.py',
  ].map((n) => path.join(p.appDirectory, n));
  const stamps = files.map((f) => fs.statSync(f).mtimeMs);
  for (let i = 0; i < 3; i++) {
    const r = resolveRuntime(p);
    assert.equal(r.codex, files[0]);
    assert.equal(r.python, files[1]);
    assert.equal(r.tools, files[2]);
    assert.equal(r.legacyPython, false);
  }
  assert.deepEqual(
    files.map((f) => fs.statSync(f).mtimeMs),
    stamps,
  );
  assert.equal(fs.existsSync(p.dataDirectory), false);
});
test('previous portable Python and installed packages are reused in place without changing the new distribution', (t) => {
  const p = setup(t);
  seed(p);
  const legacy = file(path.join(p.dataDirectory, 'runtime/python/python.exe'));
  const installed = file(
    path.join(
      p.dataDirectory,
      'runtime/python/Lib/site-packages/user_package.py',
    ),
    'my package',
  );
  const r = resolveRuntime(p);
  assert.equal(r.python, legacy);
  assert.equal(r.legacyPython, true);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'my package');
  assert.equal(r.codex, path.join(p.appDirectory, 'codex/bin/codex.exe'));
});
test('runtime lookup uses executable directory instead of the process working directory', (t) => {
  const p = setup(t);
  seed(p);
  const r = resolveRuntime(p);
  assert.ok(r.python.startsWith(p.appDirectory));
  assert.ok(r.tools.startsWith(p.appDirectory));
});
test('missing sibling runtime yields a clear complete-extraction message instead of silently downloading or recreating it', (t) => {
  const p = setup(t);
  seed(p);
  fs.rmSync(path.join(p.appDirectory, 'python/python.exe'));
  assert.throws(() => resolveRuntime(p), /解压整个文件夹/);
  assert.equal(fs.existsSync(p.dataDirectory), false);
});
test('unchanged settings are not rewritten or backed up on every launch', (t) => {
  const p = setup(t),
    preset = {
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-secret',
      model: 'gpt-6.1-sol',
    };
  new Store(p.dataDirectory, preset);
  const fileName = path.join(p.dataDirectory, 'settings.json');
  fs.utimesSync(fileName, 1000, 1000);
  const time = fs.statSync(fileName).mtimeMs;
  new Store(p.dataDirectory, preset);
  assert.equal(fs.statSync(fileName).mtimeMs, time);
  assert.equal(fs.existsSync(fileName + '.bak'), false);
});
