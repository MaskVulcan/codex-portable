'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { Store, redact } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/reported-data');
const data = path.join(out, 'data'),
  preset = JSON.parse(
    fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
  );
const { Store: OldStore } = require(path.join(out, 'legacy/src/core.cjs'));
let reproduced = false;
try {
  new OldStore(data, preset);
} catch (error) {
  assert.ok(['EACCES', 'EPERM'].includes(error.code));
  reproduced = true;
  console.log(
    '1.0.3 reproduced the reported read-only backup failure:',
    error.code,
  );
}
assert.ok(
  reproduced,
  'The original failure must reproduce against the supplied file attributes',
);
const store = new Store(data, preset);
assert.equal(store.settings.activeProfileId, '4router-core');
assert.equal(store.settings.reasoningEffort, 'xhigh');
const id = '12a93acf-fe35-48e7-a344-f4703114acec';
const chat = store.get(id);
assert.ok(chat.messages.some((m) => m.role === 'user' && m.text === '你好'));
assert.equal(chat.busy, false);
store.save(chat);
store.save(chat);
store.saveSettings({ model: 'gpt-6.1-sol' });
store.saveSettings({ fastMode: true });
const restarted = new Store(data, preset);
assert.equal(restarted.settings.activeProfileId, '4router-core');
assert.equal(restarted.settings.reasoningEffort, 'xhigh');
assert.ok(restarted.get(id).messages.length);
const report = {
  passed: true,
  legacyFailureReproduced: true,
  readOnlyFilesRepaired: true,
  orphanedMessageRecovered: true,
  profileAndEffortPreserved: true,
  repeatedSaveAndRestart: true,
  platform: process.platform,
  nativeWindowsRun: false,
  timestamp: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(out, 'report.json'),
  JSON.stringify(report, null, 2),
);
console.log('REPORTED DATA REGRESSION PASSED');
