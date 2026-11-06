'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { CodexRpc } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/fast');
fs.mkdirSync(out, { recursive: true });
const preset = JSON.parse(
  fs.readFileSync(path.join(root, 'payload/provisioning.json'), 'utf8'),
);
const captured = [];
let rpc;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!req.url.startsWith('/v1/responses')) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks));
  captured.push({
    serviceTier: body.service_tier,
    effort: body.reasoning?.effort,
  });
  const id = 'resp_fast_' + captured.length,
    mid = 'msg_fast_' + captured.length,
    text = 'FAST_PARAMETER_OK';
  const item = {
    id: mid,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: preset.model,
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 12,
      output_tokens: 6,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: mid,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: mid,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: mid,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n');
  res.end();
});
async function start(settings, name) {
  const c = new CodexRpc({
    executable: require('./test-env.cjs').codex,
    home: path.join(out, name),
    settings,
    log: () => {},
  });
  await c.start();
  return c;
}
async function turn(threadId, tier, effort, text) {
  const messages = [];
  let timeout;
  const done = new Promise((resolve, reject) => {
    const listener = ({ method, params: p }) => {
      if (p.threadId !== threadId) return;
      if (method === 'item/completed' && p.item?.type === 'agentMessage')
        messages.push(p.item.text);
      if (method === 'turn/completed') {
        clearTimeout(timeout);
        rpc.off('notification', listener);
        if (p.turn.status === 'failed')
          reject(new Error(p.turn.error?.message || 'Turn failed'));
        else resolve(messages.join('\n'));
      }
    };
    timeout = setTimeout(() => {
      rpc.off('notification', listener);
      reject(new Error('Fast verification timed out'));
    }, 120000);
    rpc.on('notification', listener);
  });
  await rpc.request(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text }],
      effort,
      serviceTier: tier,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
    60000,
  );
  return done;
}
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  rpc = await start(
    {
      ...preset,
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      apiKey: 'local-test',
      fastMode: true,
      webSearch: false,
    },
    'captured-home',
  );
  const { thread } = await rpc.request('thread/start', {
    cwd: out,
    model: preset.model,
    modelProvider: 'portable_relay',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  await turn(thread.id, 'fast', 'xhigh', 'Reply with the test marker.');
  assert.equal(captured.at(-1).serviceTier, 'priority');
  assert.equal(captured.at(-1).effort, 'xhigh');
  await turn(thread.id, 'default', 'high', 'Reply with the test marker again.');
  assert.ok(
    !captured.at(-1).serviceTier || captured.at(-1).serviceTier === 'default',
  );
  assert.equal(captured.at(-1).effort, 'high');
  rpc.close();
  await new Promise((r) => setTimeout(r, 600));
  rpc = await start(preset, 'real-relay-home');
  const real = await rpc.request('thread/start', {
    cwd: out,
    model: preset.model,
    modelProvider: 'portable_relay',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  const response = await turn(
    real.thread.id,
    'fast',
    'xhigh',
    '这是连接测试。请只回复 FAST_RELAY_OK，不执行任何命令。',
  );
  assert.ok(response.includes('FAST_RELAY_OK'));
  const report = {
    passed: true,
    defaultFastMode: preset.fastMode,
    defaultReasoningEffort: preset.reasoningEffort,
    capturedRequests: captured,
    relayAcceptsFastRequest: true,
    accelerationMeasured: false,
    platform: process.platform,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
})()
  .catch((e) => {
    console.error('FAST SMOKE FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    rpc?.close();
    server.close();
  });
