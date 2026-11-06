'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  createJsonStorage,
  atomicJson,
  readJson,
} = require('../src/persistence.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-save-'));
  t.after(() => {
    for (const p2 of fs.readdirSync(p)) {
      try {
        fs.chmodSync(path.join(p, p2), 0o600);
      } catch {}
    }
    fs.rmSync(p, { recursive: true, force: true });
  });
  return p;
}
function denied() {
  return Object.assign(new Error('simulated Windows sharing violation'), {
    code: 'EPERM',
  });
}
test('repeated saves repair read-only JSON and backup files as in the reported archive', (t) => {
  const file = path.join(temp(t), 'settings.json');
  atomicJson(file, { v: 1 });
  atomicJson(file, { v: 2 });
  fs.chmodSync(file, 0o444);
  fs.chmodSync(file + '.bak', 0o444);
  atomicJson(file, { v: 3 });
  atomicJson(file, { v: 4 });
  assert.deepEqual(readJson(file, null), { v: 4 });
  assert.ok(fs.statSync(file).mode & 0o200);
  assert.ok(fs.statSync(file + '.bak').mode & 0o200);
});
test('transient Windows rename denial is retried without deleting valid data', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { v: 1 });
  let attempts = 0;
  const io = {
    ...fs,
    renameSync: (from, to) => {
      attempts++;
      if (attempts < 3) throw denied();
      return fs.renameSync(from, to);
    },
  };
  const storage = createJsonStorage({ io, pause: () => {} });
  storage.atomicJson(file, { v: 2 });
  assert.equal(attempts, 3);
  assert.deepEqual(readJson(file, null), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), { v: 1 });
});
test('a persistent replacement lock falls back to a durable write and keeps a backup', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { v: 1 });
  const storage = createJsonStorage({
    io: {
      ...fs,
      renameSync: () => {
        throw denied();
      },
    },
    pause: () => {},
  });
  storage.atomicJson(file, { v: 2 });
  assert.deepEqual(readJson(file, null), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), { v: 1 });
  assert.equal(
    fs.readdirSync(path.dirname(file)).some((n) => n.includes('.tmp-')),
    false,
  );
});
test('a locked backup does not prevent an otherwise successful save', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { v: 1 });
  const storage = createJsonStorage({
    io: {
      ...fs,
      copyFileSync: () => {
        throw denied();
      },
    },
    pause: () => {},
  });
  storage.atomicJson(file, { v: 2 });
  assert.deepEqual(readJson(file, null), { v: 2 });
});
test('total write failure preserves old primary and recovers the newer complete temporary JSON', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { v: 1 });
  const storage = createJsonStorage({
    io: {
      ...fs,
      renameSync: () => {
        throw denied();
      },
      openSync: (name, ...args) => {
        if (name === file) throw denied();
        return fs.openSync(name, ...args);
      },
    },
    pause: () => {},
  });
  assert.throws(() => storage.atomicJson(file, { v: 2 }), /恢复文件/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 1 });
  assert.deepEqual(readJson(file, null), { v: 2 });
  atomicJson(file, { v: 3 });
  assert.deepEqual(readJson(file, null), { v: 3 });
});
test('old fixed .tmp files left by 1.0.3 recover unsaved messages before stale primary', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { messages: [] });
  fs.utimesSync(file, 1000, 1000);
  fs.writeFileSync(
    file + '.tmp',
    JSON.stringify({ messages: [{ role: 'user', text: '你好' }] }),
  );
  assert.equal(readJson(file, null).messages[0].text, '你好');
});
test('unreadable recovery-copy destination cannot block fallback to a valid backup', (t) => {
  const file = path.join(temp(t), 'history.json');
  atomicJson(file, { v: 1 });
  atomicJson(file, { v: 2 });
  fs.writeFileSync(file, 'broken json');
  const storage = createJsonStorage({
    io: {
      ...fs,
      copyFileSync: () => {
        throw denied();
      },
    },
    pause: () => {},
  });
  assert.deepEqual(storage.readJson(file, null), { v: 1 });
});
