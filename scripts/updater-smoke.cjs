'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  CliUpdater,
  selectRelease,
  verifiedDownload,
  extractPackage,
  validatePackage,
  probeCli,
} = require('../src/updater.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/updater');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const release = selectRelease(
    JSON.parse(
      fs.readFileSync(path.join(root, 'downloads/codex-release.json'), 'utf8'),
    ),
  );
  const updater = new CliUpdater({
    root: path.join(out, 'data'),
    payload: path.join(root, 'payload'),
    fetchRelease: async () => release,
  });
  const status = await updater.check();
  assert.equal(status.latestVersion, release.version);
  console.log('Official stable release selection passed:', release.version);
  const archive = path.join(
      root,
      'downloads',
      `codex-${release.version}-windows.tar.gz`,
    ),
    verified = path.join(out, 'verified.tar.gz');
  fs.rmSync(verified, { force: true });
  await verifiedDownload(fs.createReadStream(archive), release, verified);
  console.log('Official package SHA-256 and size passed');
  const directory = path.join(out, 'unpacked');
  fs.mkdirSync(directory, { recursive: true });
  await extractPackage(verified, directory);
  await validatePackage(directory, release.version);
  console.log('Full Windows package extraction and PE validation passed');
  const executable = require('./test-env.cjs').codex;
  const nativeDirectory = path.dirname(
    path.dirname(require('./test-env.cjs').resolveCommand(executable)),
  );
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
  );
  await probeCli({
    executable,
    directory: nativeDirectory,
    version: '0.166.0',
    home: path.join(out, 'protocol-home'),
    settings,
  });
  console.log(
    'Actual Codex version and app-server handshake probe passed (Linux)',
  );
  const report = {
    passed: true,
    officialStableVersion: release.version,
    officialDigestVerified: true,
    windowsFullPackageValidated: true,
    nativeProtocolProbe: true,
    nativeWindowsRun: false,
    transactionTests: 10,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  fs.rmSync(verified, { force: true });
  console.log('UPDATER SMOKE PASSED');
})().catch((e) => {
  console.error('UPDATER SMOKE FAILED:', e.message);
  process.exitCode = 1;
});
