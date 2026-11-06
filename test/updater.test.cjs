'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { Readable } = require('node:stream'),
  tar = require('tar');
const {
  CliUpdater,
  selectRelease,
  safeEntry,
  safeUrl,
  validatePackage,
  extractPackage,
  verifiedDownload,
} = require('../src/updater.cjs');
const { atomicJson } = require('../src/core.cjs');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-updater-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
function seed(directory, version) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'codex-package.json'),
    JSON.stringify({
      layoutVersion: 1,
      version,
      target: 'x86_64-pc-windows-msvc',
      variant: 'codex',
      entrypoint: 'bin/codex.exe',
    }),
  );
  for (const name of [
    'bin/codex.exe',
    'bin/codex-exec-server.exe',
    'bin/codex-code-mode-host.exe',
    'codex-path/rg.exe',
  ]) {
    const b = Buffer.alloc(256);
    b.write('MZ');
    b.writeUInt32LE(64, 0x3c);
    b.write('PE\0\0', 64, 'ascii');
    b.writeUInt16LE(0x8664, 68);
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), b);
  }
}
function fixture(t, overrides = {}) {
  const directory = temp(t),
    root = path.join(directory, 'data'),
    payload = path.join(directory, 'payload');
  fs.mkdirSync(payload);
  atomicJson(path.join(payload, 'manifest.json'), { codexVersion: '0.166.0' });
  seed(path.join(root, 'runtime/codex'), '0.166.0');
  fs.mkdirSync(path.join(root, 'runtime/python'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'runtime/python/my-dependency.txt'),
    'keep python',
  );
  fs.mkdirSync(path.join(root, 'codex-home/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'codex-home/sessions/history.jsonl'),
    'keep session',
  );
  fs.writeFileSync(path.join(root, 'settings.json'), 'keep API settings');
  const source = path.join(directory, 'new-package');
  seed(source, '0.167.0');
  const archive = path.join(directory, 'new.tgz');
  tar.c({ gzip: true, sync: true, file: archive, cwd: source }, [
    'bin',
    'codex-path',
    'codex-package.json',
  ]);
  const bytes = fs.readFileSync(archive);
  const release = {
    version: '0.167.0',
    size: bytes.length,
    sha256: hash(bytes),
    url: 'https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
  };
  let activated = 0;
  const options = {
    root,
    payload,
    fetchRelease: async () => release,
    download: (r, file, { signal, progress }) =>
      verifiedDownload(Readable.from([bytes]), r, file, { signal, progress }),
    probe: async () => {},
    afterSwitch: async () => {
      activated++;
    },
    ...overrides,
  };
  const updater = new CliUpdater(options);
  return {
    directory,
    root,
    payload,
    source,
    archive,
    release,
    bytes,
    updater,
    options,
    get activated() {
      return activated;
    },
  };
}
test('release selection accepts only stable official x64 packages with a digest', () => {
  const good = {
    tag_name: 'rust-v0.167.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
        size: 202589789,
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url:
          'https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-package-x86_64-pc-windows-msvc.tar.gz',
      },
    ],
  };
  assert.equal(selectRelease(good).version, '0.167.0');
  for (const change of [
    { prerelease: true },
    { draft: true },
    { tag_name: 'rust-v0.167.0-alpha.1' },
    { assets: [{ ...good.assets[0], digest: null }] },
    {
      assets: [
        {
          ...good.assets[0],
          browser_download_url: 'https://evil.test/download',
        },
      ],
    },
  ])
    assert.throws(() => selectRelease({ ...good, ...change }));
  assert.throws(() => safeUrl('http://github.com/a'));
  assert.throws(() => safeUrl('https://evil.test/a'));
  assert.throws(() => safeUrl('https://user:pass@github.com/a'));
});
test('download rejects wrong digest, truncation and oversized content', async (t) => {
  const p = temp(t),
    bytes = Buffer.from('a real archive'),
    r = { size: bytes.length, sha256: hash(bytes) };
  await verifiedDownload(Readable.from([bytes]), r, path.join(p, 'good'));
  await assert.rejects(
    verifiedDownload(
      Readable.from([bytes]),
      { ...r, sha256: '0'.repeat(64) },
      path.join(p, 'bad-hash'),
    ),
    /校验失败/,
  );
  await assert.rejects(
    verifiedDownload(
      Readable.from([bytes.subarray(1)]),
      r,
      path.join(p, 'short'),
    ),
    /校验失败/,
  );
  await assert.rejects(
    verifiedDownload(
      Readable.from([Buffer.concat([bytes, Buffer.from('extra')])]),
      r,
      path.join(p, 'long'),
    ),
    /大小/,
  );
});
test('update and rollback persist selected version without changing Python, settings or sessions', async (t) => {
  const f = fixture(t);
  const checked = await f.updater.check();
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.busy, false);
  let status = await f.updater.install();
  assert.equal(status.currentVersion, '0.167.0');
  assert.equal(status.previousVersion, '0.166.0');
  assert.equal(status.busy, false);
  assert.equal(f.activated, 1);
  const restarted = new CliUpdater(f.options);
  await restarted.initialize();
  assert.equal(restarted.status().currentVersion, '0.167.0');
  assert.ok((await restarted.executable()).includes('cli-versions'));
  status = await restarted.rollback();
  assert.equal(status.currentVersion, '0.166.0');
  assert.equal(status.previousVersion, '0.167.0');
  assert.equal(status.busy, false);
  assert.equal(
    fs.readFileSync(
      path.join(f.root, 'runtime/python/my-dependency.txt'),
      'utf8',
    ),
    'keep python',
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'),
    'keep API settings',
  );
  assert.equal(
    fs.readFileSync(
      path.join(f.root, 'codex-home/sessions/history.jsonl'),
      'utf8',
    ),
    'keep session',
  );
});
test('failed preflight never activates a downloaded CLI', async (t) => {
  const f = fixture(t, {
    probe: async () => {
      throw new Error('incompatible protocol');
    },
  });
  await assert.rejects(f.updater.install(), /incompatible protocol/);
  assert.equal(f.updater.status().currentVersion, '0.166.0');
  assert.equal(f.activated, 0);
  assert.ok(fs.existsSync(path.join(f.root, 'runtime/codex/bin/codex.exe')));
});
test('failed startup restores original version and a pre-migration native history snapshot', async (t) => {
  let root;
  const f = fixture(t, {
    afterSwitch: async () => {
      fs.writeFileSync(
        path.join(root, 'codex-home/sessions/history.jsonl'),
        'migrated incompatible data',
      );
      throw new Error('cannot initialize');
    },
  });
  root = f.root;
  await assert.rejects(f.updater.install(), /已恢复原版本/);
  assert.equal(f.updater.status().currentVersion, '0.166.0');
  assert.equal(
    fs.readFileSync(
      path.join(root, 'codex-home/sessions/history.jsonl'),
      'utf8',
    ),
    'keep session',
  );
  assert.equal(new CliUpdater(f.options).state.active.version, '0.166.0');
  assert.equal(f.updater.state.pending, undefined);
});
test('interrupted activation recovers at next app launch', async (t) => {
  const f = fixture(t),
    id = '0123456789abcdef',
    transaction = path.join(f.root, 'updates/transactions', id);
  fs.mkdirSync(transaction, { recursive: true });
  fs.cpSync(
    path.join(f.root, 'codex-home'),
    path.join(transaction, 'native-home'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(f.root, 'codex-home/sessions/history.jsonl'),
    'partially migrated',
  );
  atomicJson(path.join(f.root, 'runtime/.cli-state.json'), {
    active: {
      version: '0.167.0',
      directory: 'cli-versions/0.167.0-0123456789abcdef',
    },
    previous: { version: '0.166.0', directory: 'codex' },
    pending: {
      transaction: id,
      homeExisted: true,
      from: { version: '0.166.0', directory: 'codex' },
      previous: null,
    },
  });
  const restarted = new CliUpdater(f.options);
  await restarted.initialize();
  assert.equal(restarted.status().currentVersion, '0.166.0');
  assert.equal(
    fs.readFileSync(
      path.join(f.root, 'codex-home/sessions/history.jsonl'),
      'utf8',
    ),
    'keep session',
  );
  await restarted.initialize();
  assert.equal(restarted.state.pending, undefined);
});
test('malicious paths and symlinks are rejected during extraction', async (t) => {
  for (const p of [
    '../escape',
    'C:/Windows/a',
    '/absolute',
    'bin/NUL.exe',
    'bin/../escape',
    'bin/file.',
  ])
    assert.equal(safeEntry({ path: p, type: 'File' }), false);
  const f = fixture(t);
  fs.symlinkSync('/tmp', path.join(f.source, 'external'));
  const archive = path.join(f.directory, 'evil.tgz');
  tar.c({ gzip: true, sync: true, file: archive, cwd: f.source }, ['external']);
  const target = path.join(f.directory, 'extract');
  fs.mkdirSync(target);
  await assert.rejects(extractPackage(archive, target), /不支持的路径/);
  assert.equal(fs.existsSync(path.join(target, 'external')), false);
});
test('cancellation leaves original version usable and prevents concurrent updates', async (t) => {
  let begun;
  const starting = new Promise((r) => {
    begun = r;
  });
  const f = fixture(t, {
    download: async (_r, _file, { signal }) => {
      begun();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const job = f.updater.install();
  await starting;
  await assert.rejects(f.updater.install(), /正在检查或更新/);
  assert.equal(f.updater.cancel(), true);
  await assert.rejects(job, /取消/);
  assert.equal(f.updater.status().currentVersion, '0.166.0');
  assert.equal(f.updater.status().busy, false);
});
test('wrong architecture or version is refused before switching', async (t) => {
  const f = fixture(t);
  await assert.rejects(validatePackage(f.source, '0.168.0'), /不匹配/);
  const file = path.join(f.source, 'bin/codex.exe'),
    b = fs.readFileSync(file);
  b.writeUInt16LE(0xaa64, 68);
  fs.writeFileSync(file, b);
  await assert.rejects(
    validatePackage(f.source, '0.167.0'),
    /不是 Windows x64/,
  );
});
test('previous manual CLI replacement is detected and never silently downgraded', async (t) => {
  const f = fixture(t);
  seed(path.join(f.root, 'runtime/codex'), '0.170.0');
  const u = new CliUpdater(f.options);
  const result = await u.check();
  assert.equal(result.currentVersion, '0.170.0');
  assert.equal(result.updateAvailable, false);
  const installed = await u.install();
  assert.equal(installed.currentVersion, '0.170.0');
});
test('directory distribution updates and rolls back with a sibling bundled CLI', async (t) => {
  const f = fixture(t),
    bundled = path.join(f.directory, 'app/codex');
  seed(bundled, '0.166.0');
  fs.rmSync(path.join(f.root, 'runtime/codex'), {
    recursive: true,
    force: true,
  });
  const updater = new CliUpdater({ ...f.options, bundledDirectory: bundled });
  assert.equal(await updater.executable(), path.join(bundled, 'bin/codex.exe'));
  await updater.install();
  assert.equal(updater.status().currentVersion, '0.167.0');
  assert.ok(
    (await updater.executable()).startsWith(
      path.join(f.root, 'runtime/cli-versions'),
    ),
  );
  await updater.rollback();
  assert.equal(await updater.executable(), path.join(bundled, 'bin/codex.exe'));
  assert.equal(fs.existsSync(path.join(f.root, 'runtime/codex')), false);
});
test('a newer manually installed CLI from old data survives migration to the directory distribution', async (t) => {
  const f = fixture(t),
    bundled = path.join(f.directory, 'app/codex');
  seed(bundled, '0.166.0');
  seed(path.join(f.root, 'runtime/codex'), '0.170.0');
  const updater = new CliUpdater({ ...f.options, bundledDirectory: bundled });
  assert.equal(updater.status().currentVersion, '0.170.0');
  assert.equal(
    await updater.executable(),
    path.join(f.root, 'runtime/codex/bin/codex.exe'),
  );
});
