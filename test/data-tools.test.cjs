'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  tar = require('tar');
const {
  backupData,
  extractBackup,
  zipFiles,
} = require('../src/data-tools.cjs');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-backup-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
test('backup and restore preserve settings, histories, snapshots and drafts without runtime caches', async (t) => {
  const p = temp(t),
    root = path.join(p, 'data');
  for (const name of [
    'settings.json',
    'workspace.json',
    'conversations/chat.json',
    'originals/task/original.txt',
    'attachments/a.png',
    'codex-home/sessions/rollout.jsonl',
    'codex-home/cache/unneeded.txt',
  ]) {
    const f = path.join(root, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'content:' + name);
  }
  const archive = path.join(p, 'backup.tar.gz');
  await backupData(root, archive);
  const restored = path.join(p, 'restored');
  await extractBackup(archive, restored);
  assert.equal(
    fs.readFileSync(path.join(restored, 'originals/task/original.txt'), 'utf8'),
    'content:originals/task/original.txt',
  );
  assert.ok(fs.existsSync(path.join(restored, 'workspace.json')));
  assert.ok(!fs.existsSync(path.join(restored, 'codex-home/cache')));
  await assert.rejects(
    backupData(root, path.join(root, 'self.tar.gz')),
    /之外/,
  );
});
test('backup restore rejects symlinks rather than following paths outside the selected restore directory', async (t) => {
  const p = temp(t);
  fs.mkdirSync(path.join(p, 'source'));
  fs.symlinkSync('/tmp', path.join(p, 'source/escape'));
  const archive = path.join(p, 'bad.tar.gz');
  tar.c(
    { file: archive, cwd: path.join(p, 'source'), gzip: true, sync: true },
    ['escape'],
  );
  await assert.rejects(
    extractBackup(archive, path.join(p, 'restored')),
    /不支持/,
  );
  assert.equal(fs.existsSync(path.join(p, 'restored/escape')), false);
});
test('result archive is a real ZIP with named original files', async (t) => {
  const p = temp(t),
    file = path.join(p, '报告.txt'),
    zip = path.join(p, 'results.zip');
  fs.writeFileSync(file, 'result');
  await zipFiles(zip, [{ path: file, name: '报告.txt' }]);
  const b = fs.readFileSync(zip);
  assert.equal(b.subarray(0, 2).toString(), 'PK');
  assert.ok(b.includes(Buffer.from('报告.txt')));
});
