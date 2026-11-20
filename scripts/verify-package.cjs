'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'),
  distribution = path.join(root, 'dist/win-unpacked'),
  resources = path.join(distribution, 'resources');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/manifest.json'), 'utf8'),
);
let runtimeFiles = 0;
for (const [name, expected] of Object.entries(manifest.files)) {
  if (!name.startsWith('codex/') && !name.startsWith('python/')) continue;
  const data = fs.readFileSync(path.join(distribution, name));
  assert.equal(data.length, expected.size, name + ' size');
  assert.equal(hash(data), expected.sha256, name + ' hash');
  runtimeFiles++;
}
const archive = path.join(resources, 'app.asar'),
  sources = [
    'src/core.cjs',
    'src/workflow.cjs',
    'src/data-tools.cjs',
    'src/browser-bridge.cjs',
    'src/browser-collection.cjs',
    'src/progress.cjs',
    'src/persistence.cjs',
    'src/attachments.cjs',
    'src/runtime.cjs',
    'src/benchmark.cjs',
    'src/inheritance.cjs',
    'src/conversation-history.cjs',
    'src/main.cjs',
    'src/preload.cjs',
    'src/updater.cjs',
    'src/ui/index.html',
    'src/ui/styles.css',
    'src/ui/renderer.js',
    'src/ui/inherit.html',
    'src/pet-state.cjs',
    'src/pet-controller.cjs',
    'src/pet-preload.cjs',
    'src/pet/index.html',
    'src/pet/pet.css',
    'src/pet/pet.js',
    'src/pet/quick.html',
    'src/pet/quick.css',
    'src/pet/quick.js',
  ];
for (const name of sources)
  assert.equal(
    hash(asar.extractFile(archive, name)),
    hash(fs.readFileSync(path.join(root, name))),
    name + ' stale',
  );
assert.equal(
  hash(fs.readFileSync(path.join(distribution, 'scripts/office_tools.py'))),
  hash(fs.readFileSync(path.join(root, 'assets/office_tools.py'))),
);
const petManifest = JSON.parse(
  fs.readFileSync(path.join(distribution, 'pets/manifest.json')),
);
let petBytes = 0;
for (const [name, entry] of Object.entries(petManifest.files)) {
  const data = name.startsWith('pets/')
    ? fs.readFileSync(path.join(distribution, name))
    : asar.extractFile(
        archive,
        'assets/pet-vendor/' + name.slice('vendor/'.length),
      );
  assert.equal(hash(data), entry.sha256, name + ' pet asset mismatch');
  petBytes += data.length;
}
for (const name of [
  'node_modules/marked/package.json',
  'node_modules/dompurify/package.json',
  'node_modules/tar/package.json',
  'node_modules/ws/package.json',
])
  assert.equal(
    JSON.parse(asar.extractFile(archive, name)).version,
    JSON.parse(fs.readFileSync(path.join(root, name))).version,
    name + ' dependency version mismatch',
  );
for (const name of [
  'node_modules/marked/lib/marked.umd.js',
  'node_modules/dompurify/dist/purify.min.js',
  'node_modules/ws/index.js',
])
  assert.equal(
    hash(asar.extractFile(archive, name)),
    hash(fs.readFileSync(path.join(root, name))),
    name + ' dependency content mismatch',
  );
for (const name of [
  'Codex Portable.exe',
  'codex/bin/codex.exe',
  'codex/bin/codex-code-mode-host.exe',
  'codex/bin/codex-exec-server.exe',
  'python/python.exe',
  'python/msvcp140.dll',
]) {
  const b = fs.readFileSync(path.join(distribution, name));
  assert.equal(b.subarray(0, 2).toString(), 'MZ');
  assert.equal(
    b.readUInt16LE(b.readUInt32LE(0x3c) + 4),
    0x8664,
    name + ' wrong architecture',
  );
}
const provision = JSON.parse(
  fs.readFileSync(path.join(distribution, 'config/provisioning.json'), 'utf8'),
);
assert.ok(
  JSON.stringify(provision) ===
    JSON.stringify(
      JSON.parse(
        fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
      ),
    ),
  'Packaged relay configuration differs from prepared configuration',
);
assert.equal(provision.fastMode, true);
assert.equal(provision.reasoningEffort, 'xhigh');
assert.equal(provision.profiles.length, 2);
assert.deepEqual(
  provision.profiles.map((p) => p.name),
  ['axhan', '4router'],
);
assert.ok(
  provision.profiles.every(
    (p) =>
      p.model === 'gpt-6.1-sol' && p.reasoningEffort === 'xhigh' && p.fastMode,
  ),
);
const fourRouter = provision.profiles.find((p) => p.id === '4router-core');
assert.ok(fourRouter);
assert.equal(fourRouter.baseUrl, 'https://4router.ai/v1');
assert.deepEqual(fourRouter.models, [
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
]);
assert.ok(!fs.existsSync(path.join(distribution, 'data/settings.json')));
assert.ok(!fs.existsSync(path.join(resources, 'payload')));
const mainSource = asar.extractFile(archive, 'src/main.cjs').toString();
assert.ok(!mainSource.includes('promises.cp('));
assert.ok(!mainSource.includes('PORTABLE_EXECUTABLE_DIR'));
assert.ok(!mainSource.includes('首次启动：正在准备'));
assert.equal(
  hash(fs.readFileSync(path.join(distribution, 'scripts/browser_mcp.py'))),
  hash(fs.readFileSync(path.join(root, 'assets/browser_mcp.py'))),
);
const browserExtension = path.join(distribution, 'browser-extension');
for (const name of [
  'manifest.json',
  'worker.js',
  'page.js',
  'popup.html',
  'popup.js',
  'popup.css',
])
  assert.equal(
    hash(fs.readFileSync(path.join(browserExtension, name))),
    hash(fs.readFileSync(path.join(root, 'browser-extension', name))),
    name + ' browser extension stale',
  );
const browserManifest = JSON.parse(
  fs.readFileSync(path.join(browserExtension, 'manifest.json')),
);
assert.equal(browserManifest.manifest_version, 3);
const output = path.join(root, 'test-output/package');
fs.mkdirSync(output, { recursive: true });
const extracted = path.join(output, 'unpacked-app');
fs.rmSync(extracted, { recursive: true, force: true });
asar.extractAll(archive, extracted);
assert.equal(
  typeof require(path.join(extracted, 'src/updater.cjs')).CliUpdater,
  'function',
);
assert.equal(
  typeof require(path.join(extracted, 'src/data-tools.cjs')).zipFiles,
  'function',
);
let bytes = 0,
  count = 0;
function inventory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (entry.isFile()) {
      bytes += fs.statSync(file).size;
      count++;
    }
  }
}
inventory(distribution);
const exe = path.join(distribution, 'Codex Portable.exe');
const report = {
  passed: true,
  layout: 'directory',
  selfExtracting: false,
  runtimeCopiedOnLaunch: false,
  distributionFiles: count,
  distributionBytes: bytes,
  verifiedRuntimeFiles: runtimeFiles,
  sourceFilesChecked: sources.length,
  windowsArchitecture: 'x64',
  relayPreconfigured: !!provision.apiKey,
  presetProfiles: provision.profiles.map((p) => p.name),
  portablePython: true,
  cliUpdaterBundled: true,
  live2dPet: true,
  petAssetBytes: petBytes,
  defaultFastMode: provision.fastMode,
  defaultReasoningEffort: provision.reasoningEffort,
  executableBytes: fs.statSync(exe).size,
  sha256: hash(fs.readFileSync(exe)),
  nativeWindowsRun: false,
  timestamp: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
