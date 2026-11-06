'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/startup'),
  distribution = path.join(root, 'dist/win-unpacked');
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'data');
fs.rmSync(data, { recursive: true, force: true });
const files = [
  'codex/bin/codex.exe',
  'python/python.exe',
  'scripts/office_tools.py',
].map((f) => path.join(distribution, f));
const before = files.map((f) => fs.statSync(f).mtimeMs);
async function launch(name) {
  const result = path.join(out, name + '.json'),
    begin = performance.now();
  return new Promise((resolve, reject) => {
    const p = spawn(
      require('./test-env.cjs').electron(),
      [
        '--no-sandbox',
        '--ozone-platform=headless',
        '--disable-gpu',
        path.join(__dirname, 'startup-probe.cjs'),
      ],
      {
        cwd: require('node:os').tmpdir(),
        env: {
          ...process.env,
          PORTABLE_DATA_DIR: data,
          STARTUP_DISTRIBUTION: distribution,
          STARTUP_RESULT: result,
          LD_LIBRARY_PATH: path.join(root, 'test-output/linuxlibs'),
          FONTCONFIG_FILE: path.join(root, 'test-output/fontconfig.xml'),
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let error = '';
    p.stderr.on('data', (b) => {
      error = (error + b.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('Startup timed out'));
    }, 30000);
    p.on('error', reject);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(result)) {
        reject(new Error(error || 'Startup failed'));
        return;
      }
      const r = JSON.parse(fs.readFileSync(result));
      r.processWallMs = performance.now() - begin;
      resolve(r);
    });
  });
}
(async () => {
  const first = await launch('first'),
    settings = path.join(data, 'settings.json'),
    stamp = fs.statSync(settings).mtimeMs;
  const second = await launch('second');
  assert.equal(fs.statSync(settings).mtimeMs, stamp);
  const third = await launch('third');
  for (const r of [first, second, third]) {
    assert.equal(r.profiles, 2);
    assert.equal(r.runtimeCreated, false);
  }
  assert.deepEqual(
    files.map((f) => fs.statSync(f).mtimeMs),
    before,
  );
  assert.equal(fs.existsSync(path.join(data, 'runtime')), false);
  const report = {
    passed: true,
    platform: process.platform,
    realElectron: true,
    builtApplication: true,
    first,
    second,
    third,
    noRuntimeExtraction: true,
    siblingRuntimeUnchanged: true,
    settingsUnchangedOnRepeatedLaunch: true,
    workingDirectory: require('node:os').tmpdir(),
    nativeWindowsRun: false,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error('STARTUP SMOKE FAILED:', e.message);
  process.exitCode = 1;
});
