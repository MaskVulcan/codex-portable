'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { Store, CodexRpc, redact } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/profiles');
fs.mkdirSync(out, { recursive: true });
const preset = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
);
const store = new Store(path.join(out, 'data'), preset);
let rpc;
async function connect() {
  rpc = new CodexRpc({
    executable: require('./test-env.cjs').codex,
    home: path.join(out, 'codex-home'),
    settings: { ...store.settings },
    log: () => {},
  });
  await rpc.start();
}
async function close() {
  const p = rpc?.process;
  if (!p) return;
  const exited = new Promise((resolve) => p.once('close', resolve));
  rpc.close();
  await exited;
}
async function turn(threadId, text) {
  const messages = [];
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.off('notification', receive);
      reject(new Error('Profile relay reply timed out'));
    }, 150000);
    const receive = ({ method, params: p }) => {
      if (p.threadId !== threadId) return;
      if (method === 'item/completed' && p.item?.type === 'agentMessage')
        messages.push(p.item.text);
      if (method === 'turn/completed') {
        clearTimeout(timer);
        rpc.off('notification', receive);
        if (p.turn.status === 'failed')
          reject(new Error(p.turn.error?.message || 'Profile request failed'));
        else resolve(messages.join('\n'));
      }
    };
    rpc.on('notification', receive);
  });
  await rpc.request('turn/start', {
    threadId,
    model: store.settings.model,
    effort: store.settings.reasoningEffort,
    serviceTier: store.settings.fastMode ? 'fast' : 'default',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    input: [{ type: 'text', text }],
  });
  return finished;
}
(async () => {
  assert.equal(store.settings.profiles.length, 2);
  assert.equal(
    JSON.stringify(store.publicSettings()).includes(preset.profiles[1].apiKey),
    false,
  );
  store.selectProfile('4router-core');
  await connect();
  const { thread } = await rpc.request('thread/start', {
    cwd: out,
    model: store.settings.model,
    modelProvider: 'portable_relay',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  const text = await turn(
    thread.id,
    '连接测试：记住口令 PROFILE_SWITCH_103。只回复 FOUR_ROUTER_OK，不运行命令或联网工具。',
  );
  assert.ok(text.includes('FOUR_ROUTER_OK'));
  console.log(
    '4Router real Responses API conversation with Fast enabled passed',
  );
  await close();
  store.selectProfile('relay-default');
  await connect();
  await rpc.request('thread/resume', {
    threadId: thread.id,
    cwd: out,
    model: store.settings.model,
    modelProvider: 'portable_relay',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  const resumed = await turn(
    thread.id,
    '请只返回我前面让你记住的口令，不执行命令。',
  );
  assert.ok(resumed.includes('PROFILE_SWITCH_103'));
  console.log(
    'Original relay resumed the same native conversation after profile switch',
  );
  await close();
  const restored = new Store(path.join(out, 'data'), preset);
  assert.equal(restored.settings.activeProfileId, 'relay-default');
  assert.equal(restored.settings.profiles.length, 2);
  const report = {
    passed: true,
    presetProfiles: store.publicSettings().profiles.map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      models: p.models,
    })),
    fourRouterResponses: true,
    fastRequestAccepted: true,
    crossRelayHistoryResume: true,
    publicSettingsHideAllKeys: true,
    profilePersistence: true,
    nativeWindowsRun: false,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('PROFILES SMOKE PASSED');
})()
  .catch((e) => {
    console.error('PROFILES SMOKE FAILED:', redact(e.message, store.secrets()));
    process.exitCode = 1;
  })
  .finally(() => rpc?.close());
