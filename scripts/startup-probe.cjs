'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path');
const target = process.env.STARTUP_DISTRIBUTION;
if (!target || !process.env.STARTUP_RESULT)
  throw new Error('Startup probe paths missing');
const started = performance.now();
process.env.PORTABLE_APP_DIR = target;
process.env.PORTABLE_PAYLOAD_DIR = path.join(target, 'config');
require(path.join(target, 'resources/app.asar/src/main.cjs'));
app
  .whenReady()
  .then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('Window missing');
    if (win.webContents.isLoading())
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    const initial = await win.webContents.executeJavaScript(
      'window.portable.initialize()',
    );
    const data = process.env.PORTABLE_DATA_DIR;
    fs.writeFileSync(
      process.env.STARTUP_RESULT,
      JSON.stringify({
        appReadyMs: performance.now() - started,
        cliVersion: initial.cli.currentVersion,
        profiles: initial.settings.profiles.length,
        runtimeCreated:
          fs.existsSync(path.join(data, 'runtime/codex')) ||
          fs.existsSync(path.join(data, 'runtime/python')),
      }),
    );
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
    if (process.exitCode) app.exit(process.exitCode);
  });
