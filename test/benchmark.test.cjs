'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  measure,
  RelayBenchmark,
  benchmarkRequest,
} = require('../src/benchmark.cjs');
const profiles = [
  {
    id: 'a',
    name: 'axhan',
    baseUrl: 'https://a.example/v1',
    apiKey: 'private-a',
  },
  {
    id: 'b',
    name: '4router',
    baseUrl: 'https://b.example/v1',
    apiKey: 'private-b',
  },
];
const parameters = {
  model: 'gpt-6.1-sol',
  reasoningEffort: 'xhigh',
  fastMode: true,
};
function response(events) {
  const text = events
    .map((e) => 'data: ' + JSON.stringify(e) + '\r\n\r\n')
    .join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7)
          c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const output = Array.from({ length: 40 }, (_, i) => i + 1).join(' ');
test('benchmark uses identical real model requests with xhigh and priority, correct per-relay auth, and handles fragmented streaming', async () => {
  const calls = [];
  let tick = 0;
  for (const profile of profiles) {
    const result = await measure(profile, parameters, {
      now: () => (tick += 10),
      transport: async (url, options) => {
        calls.push({ url, options });
        return response([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.output_text.delta', delta: output.slice(0, 30) },
          { type: 'response.output_text.delta', delta: output.slice(30) },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: { output_tokens: 80 },
              service_tier: 'priority',
            },
          },
        ]);
      },
    });
    assert.equal(result.firstTokenMs, 10);
    assert.equal(result.totalMs, 20);
    assert.equal(result.outputTokens, 80);
  }
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-a');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-b');
  assert.notEqual(calls[0].url, calls[1].url);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.reasoning.effort, 'xhigh');
  assert.equal(body.service_tier, 'priority');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
});
test('benchmark excludes failed, incomplete, truncated and non-equivalent responses', async () => {
  await assert.rejects(
    measure(profiles[0], parameters, {
      transport: async () => new Response('no', { status: 429 }),
    }),
    /HTTP 429/,
  );
  await assert.rejects(
    measure(profiles[0], parameters, {
      transport: async () =>
        response([
          {
            type: 'response.failed',
            response: { error: { message: 'Unavailable' } },
          },
        ]),
    }),
    /Unavailable/,
  );
  await assert.rejects(
    measure(profiles[0], parameters, {
      transport: async () =>
        response([{ type: 'response.output_text.delta', delta: output }]),
    }),
    /提前断开/,
  );
  await assert.rejects(
    measure(profiles[0], parameters, {
      transport: async () =>
        response([
          { type: 'response.output_text.delta', delta: '1 2 3' },
          { type: 'response.completed', response: { status: 'completed' } },
        ]),
    }),
    /相同的测速内容/,
  );
});
test('parallel comparison reports progress, picks completed fastest, and does not mutate profile or current preferences', async () => {
  const input = structuredClone(profiles),
    updates = [];
  let active = 0,
    maxActive = 0;
  const tester = new RelayBenchmark({
    getProfiles: () => input,
    getParameters: () => parameters,
    onChange: (s) => updates.push(s),
    measureOne: async (p, _params, { onFirstToken }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      onFirstToken(p.id === 'a' ? 90 : 110);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        firstTokenMs: p.id === 'a' ? 90 : 110,
        totalMs: p.id === 'a' ? 240 : 180,
      };
    },
  });
  const result = await tester.run();
  assert.equal(maxActive, 2);
  assert.equal(result.busy, false);
  assert.equal(result.winnerId, 'b');
  assert.equal(result.rows[0].firstTokenMs, 90);
  assert.ok(
    updates.some((s) => s.busy && s.rows.some((r) => r.firstTokenMs !== null)),
  );
  assert.deepEqual(input, profiles);
  assert.equal(parameters.reasoningEffort, 'xhigh');
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('one unavailable relay does not abort another, and private tokens are removed from errors', async () => {
  const tester = new RelayBenchmark({
    getProfiles: () => profiles,
    getParameters: () => parameters,
    measureOne: async (p) => {
      if (p.id === 'a') throw new Error('Unauthorized private-a');
      return { firstTokenMs: 10, totalMs: 40 };
    },
  });
  const result = await tester.run();
  assert.equal(result.winnerId, 'b');
  assert.equal(result.rows[0].status, 'error');
  assert.equal(result.rows[1].status, 'success');
  assert.ok(!result.rows[0].error.includes('private-a'));
});
test('cancel, timeout and a second click are handled without hanging the UI', async () => {
  let ready;
  const begun = new Promise((r) => (ready = r));
  const wait = async (_p, _params, { signal }) => {
    ready();
    await new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  const tester = new RelayBenchmark({
    getProfiles: () => profiles,
    getParameters: () => parameters,
    measureOne: wait,
  });
  const job = tester.run();
  await begun;
  await assert.rejects(tester.run(), /正在测速/);
  assert.equal(tester.cancel(), true);
  const result = await job;
  assert.equal(result.busy, false);
  assert.ok(result.rows.every((r) => r.status === 'cancelled'));
  assert.equal(result.winnerId, null);
  const timeout = new RelayBenchmark({
    getProfiles: () => [profiles[0]],
    getParameters: () => parameters,
    measureOne: wait,
    timeoutMs: 5,
  });
  const timed = await timeout.run();
  assert.equal(timed.rows[0].status, 'error');
  assert.match(timed.rows[0].error, /超过/);
  assert.equal(timed.busy, false);
});
test('standard speed and other selected efforts are kept for fair user-configured comparison', () => {
  const body = benchmarkRequest({
    ...parameters,
    fastMode: false,
    reasoningEffort: 'low',
  });
  assert.equal(body.service_tier, 'default');
  assert.equal(body.reasoning.effort, 'low');
});
