'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  Store,
  atomicJson,
  DEFAULT_MODELS,
  modelCatalog,
} = require('../src/core.cjs');
const first = {
  id: 'relay-default',
  name: '原有中转',
  baseUrl: 'https://first.example/v1',
  apiKey: 'secret-for-first',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  fastMode: true,
  webSearch: true,
  models: DEFAULT_MODELS,
};
const second = {
  id: '4router-core',
  name: '4Router · 核心线路',
  baseUrl: 'https://4router.ai/v1',
  apiKey: 'secret-for-second',
  model: 'gpt-6-astra',
  reasoningEffort: 'high',
  fastMode: false,
  webSearch: true,
  models: DEFAULT_MODELS,
};
const preset = {
  ...first,
  activeProfileId: first.id,
  profiles: [first, second],
};
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
test('old single settings migrate and receive the new preset without replacing the user token', (t) => {
  const dir = temp(t);
  atomicJson(path.join(dir, 'settings.json'), {
    ...first,
    baseUrl: 'https://edited.example/v1',
    apiKey: 'user-replaced-key',
    model: 'gpt-6-luna',
    fastMode: false,
    lastDirectory: 'D:\\my files',
  });
  const store = new Store(dir, preset);
  assert.equal(store.settings.profiles.length, 2);
  assert.equal(store.settings.apiKey, 'user-replaced-key');
  assert.equal(store.settings.baseUrl, 'https://edited.example/v1');
  assert.equal(store.settings.fastMode, false);
  assert.equal(store.settings.model, 'gpt-6-luna');
  assert.equal(store.settings.lastDirectory, 'D:\\my files');
  assert.equal(store.settings.profiles[1].apiKey, second.apiKey);
  const publicText = JSON.stringify(store.publicSettings());
  for (const key of ['user-replaced-key', second.apiKey])
    assert.ok(!publicText.includes(key));
  assert.equal(store.publicSettings().profiles[1].hasApiKey, true);
});
test('switching isolates endpoint, key, model, effort and fast preferences and persists', (t) => {
  const dir = temp(t),
    store = new Store(dir, preset);
  store.selectProfile(second.id);
  assert.equal(store.settings.apiKey, second.apiKey);
  assert.equal(store.settings.baseUrl, second.baseUrl);
  assert.equal(store.settings.model, 'gpt-6-astra');
  assert.equal(store.settings.reasoningEffort, 'high');
  assert.equal(store.settings.fastMode, false);
  store.saveSettings({ fastMode: true, model: 'gpt-6.1-terra' });
  store.selectProfile(first.id);
  assert.equal(store.settings.model, first.model);
  assert.equal(store.settings.apiKey, first.apiKey);
  store.selectProfile(second.id);
  const again = new Store(dir, preset);
  assert.equal(again.settings.activeProfileId, second.id);
  assert.equal(again.settings.model, 'gpt-6.1-terra');
  assert.equal(again.settings.fastMode, true);
});
test('blank key edit targets the selected profile without borrowing the active profile key', (t) => {
  const store = new Store(temp(t), preset);
  store.saveSettings({
    profileId: second.id,
    name: '核心线路改名',
    apiKey: '',
    baseUrl: 'https://4Router.ai/v1/',
  });
  assert.equal(store.settings.apiKey, second.apiKey);
  assert.equal(store.settings.name, '核心线路改名');
  assert.equal(store.settings.baseUrl, 'https://4router.ai/v1');
  assert.equal(
    store.settings.profiles.find((p) => p.id === first.id).apiKey,
    first.apiKey,
  );
  const before = JSON.stringify(store.settings);
  assert.throws(() =>
    store.saveSettings({
      profileId: second.id,
      baseUrl: 'javascript:alert(1)',
    }),
  );
  assert.equal(JSON.stringify(store.settings), before);
});
test('new profile, deletion and restart keep preset edits and do not recreate deleted profiles', (t) => {
  const dir = temp(t),
    store = new Store(dir, preset);
  store.saveSettings({
    profileId: null,
    name: '第三套',
    baseUrl: 'https://third.example/v1',
    apiKey: 'third-key',
    model: 'gpt-6-sol',
  });
  const id = store.settings.activeProfileId;
  assert.equal(store.settings.profiles.length, 3);
  assert.ok(id.startsWith('custom-'));
  store.deleteProfile(second.id);
  const again = new Store(dir, preset);
  assert.equal(again.settings.profiles.length, 2);
  assert.ok(!again.settings.profiles.some((p) => p.id === second.id));
  assert.equal(again.settings.activeProfileId, id);
  again.deleteProfile(first.id);
  assert.throws(() => again.deleteProfile(id), /至少保留/);
  assert.equal(again.settings.apiKey, 'third-key');
});
test('catalog contains GPT-6.1 and GPT-6 family only, and catalogs belong to individual profiles', (t) => {
  const store = new Store(temp(t), preset);
  const all = [
    'gpt-6.1-sol',
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'claude',
    'gpt-60-sol',
    null,
    'gpt-6.2-sol',
  ];
  assert.deepEqual(modelCatalog(all), ['gpt-6.1-sol', 'gpt-6-astra']);
  store.setModelCatalog(second.id, all);
  assert.deepEqual(
    store.settings.profiles.find((p) => p.id === second.id).models,
    ['gpt-6.1-sol', 'gpt-6-astra'],
  );
  assert.deepEqual(
    store.settings.profiles.find((p) => p.id === first.id).models,
    DEFAULT_MODELS,
  );
});
test('new requested names and 6.1/xhigh/Fast migrate once, preserving credentials, directory, and later user overrides', (t) => {
  const dir = temp(t);
  atomicJson(path.join(dir, 'settings.json'), {
    ...first,
    profiles: [first, second],
    activeProfileId: second.id,
    lastDirectory: 'D:\\资料',
  });
  const updatedPreset = {
    ...preset,
    preferencesRevision: 2,
    profiles: [
      {
        ...first,
        name: 'axhan',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
        fastMode: true,
      },
      {
        ...second,
        name: '4router',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
        fastMode: true,
      },
    ],
  };
  const store = new Store(dir, updatedPreset);
  assert.deepEqual(
    store.settings.profiles.map((p) => p.name),
    ['axhan', '4router'],
  );
  assert.ok(
    store.settings.profiles.every(
      (p) =>
        p.model === 'gpt-6.1-sol' &&
        p.reasoningEffort === 'xhigh' &&
        p.fastMode,
    ),
  );
  assert.equal(store.settings.apiKey, second.apiKey);
  assert.equal(store.settings.activeProfileId, second.id);
  assert.equal(store.settings.lastDirectory, 'D:\\资料');
  store.saveSettings({
    name: '我改的名称',
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    fastMode: false,
  });
  const again = new Store(dir, updatedPreset);
  assert.equal(again.settings.name, '我改的名称');
  assert.equal(again.settings.model, 'gpt-6-luna');
  assert.equal(again.settings.reasoningEffort, 'low');
  assert.equal(again.settings.fastMode, false);
});
