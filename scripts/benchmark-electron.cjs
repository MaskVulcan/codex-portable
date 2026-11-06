'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/benchmark'),
  distribution = path.join(root, 'dist/win-unpacked');
fs.mkdirSync(out, { recursive: true });
process.env.PORTABLE_APP_DIR = distribution;
process.env.PORTABLE_PAYLOAD_DIR = path.join(distribution, 'config');
process.env.PORTABLE_DATA_DIR = path.join(out, 'data');
require(path.join(distribution, 'resources/app.asar/src/main.cjs'));
let window;
const js = (script) => window.webContents.executeJavaScript(script, true);
async function until(script, timeout = 150000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await js(script)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Benchmark UI timed out');
}
app
  .whenReady()
  .then(async () => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) await session.defaultSession.setProxy({ proxyRules: proxy });
    window = BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading())
      await new Promise((r) => window.webContents.once('did-finish-load', r));
    await until(
      "window.portable&&document.getElementById('model-label').options.length>=5",
      15000,
    );
    await js(
      "if(document.getElementById('onboarding').open)document.getElementById('onboarding-close').click()",
    );
    const before = await js('window.portable.initialize()');
    assert.deepEqual(
      before.settings.profiles.map((p) => p.name),
      ['axhan', '4router'],
    );
    assert.equal(before.settings.reasoningEffort, 'xhigh');
    assert.equal(before.settings.model, 'gpt-6.1-sol');
    assert.equal(before.settings.fastMode, true);
    await js("document.getElementById('benchmark-open').click()");
    await until(
      "document.querySelectorAll('#benchmark-results tr').length===2&&!document.getElementById('benchmark-rerun').disabled",
    );
    const result = await js('window.portable.benchmarkStatus()');
    console.log(JSON.stringify(result, null, 2));
    assert.equal(result.busy, false);
    assert.ok(
      result.rows.every((r) => r.status === 'success'),
      'Both relays must complete the real comparison',
    );
    assert.ok(result.winnerId);
    const after = await js('window.portable.initialize()');
    assert.equal(
      after.settings.activeProfileId,
      before.settings.activeProfileId,
    );
    assert.equal(after.settings.model, before.settings.model);
    fs.writeFileSync(
      path.join(out, 'comparison.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const report = {
      passed: true,
      realElectron: true,
      builtApplication: true,
      actualRelayRequests: true,
      parameters: result.parameters,
      rows: result.rows,
      winnerId: result.winnerId,
      doesNotChangeActiveProfile: true,
      platform: process.platform,
      nativeWindowsRun: false,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('REAL RELAY BENCHMARK PASSED');
  })
  .catch((e) => {
    console.error('BENCHMARK SMOKE FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
