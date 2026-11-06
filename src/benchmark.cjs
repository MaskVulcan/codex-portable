'use strict';
const { redact } = require('./core.cjs');

const PROMPT =
  'Reply with only the integers from 1 to 40 in ascending order, separated by single spaces. Do not add any explanation, punctuation, headings, or tools.';
function benchmarkRequest(parameters) {
  return {
    model: parameters.model,
    reasoning: { effort: parameters.reasoningEffort },
    service_tier: parameters.fastMode ? 'priority' : 'default',
    stream: true,
    store: false,
    max_output_tokens: 2048,
    instructions:
      'This is a short latency comparison. Follow the requested output format exactly.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
  };
}
async function measure(
  profile,
  parameters,
  {
    transport = fetch,
    signal,
    now = () => performance.now(),
    onFirstToken = () => {},
  } = {},
) {
  const start = now();
  let firstTokenMs = null,
    completed = false,
    output = '',
    tokens = null,
    tier = null;
  const response = await transport(
    profile.baseUrl.replace(/\/$/, '') + '/responses',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + profile.apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(benchmarkRequest(parameters)),
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('中转未返回响应流。');
  function event(data) {
    if (!data || data === '[DONE]') return;
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('中转响应格式无效。');
    }
    if (value.type === 'response.output_text.delta' && value.delta) {
      if (firstTokenMs === null) {
        firstTokenMs = now() - start;
        onFirstToken(firstTokenMs);
      }
      output += value.delta;
    }
    if (
      value.type === 'error' ||
      value.type === 'response.failed' ||
      value.type === 'response.incomplete'
    )
      throw new Error(
        value.error?.message ||
          value.response?.error?.message ||
          '模型未能完成测速回复。',
      );
    if (value.type === 'response.completed') {
      completed = true;
      const result = value.response || {};
      if (result.status && result.status !== 'completed')
        throw new Error('模型未能完整回复。');
      const fallback = (result.output || [])
        .filter((i) => i.type === 'message')
        .flatMap((i) => i.content || [])
        .filter((i) => i.type === 'output_text')
        .map((i) => i.text || '')
        .join('');
      if (!output && fallback) {
        firstTokenMs = now() - start;
        output = fallback;
        onFirstToken(firstTokenMs);
      }
      tokens = result.usage?.output_tokens ?? null;
      tier = result.service_tier ?? null;
    }
  }
  let buffer = '';
  const decoder = new TextDecoder();
  let bytes = 0;
  function drain(final = false) {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || '';
    if (final && buffer.trim()) {
      parts.push(buffer);
      buffer = '';
    }
    for (const part of parts) {
      const data = part
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      event(data);
    }
  }
  for await (const chunk of response.body) {
    signal?.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('测速响应过大，已停止读取。');
    buffer += decoder.decode(chunk, { stream: true });
    drain();
  }
  buffer += decoder.decode();
  drain(true);
  if (!completed || !output.trim())
    throw new Error('中转提前断开或没有返回文字。');
  const numbers = (output.match(/\d+/g) || []).map(Number);
  if (numbers.length !== 40 || numbers.some((n, i) => n !== i + 1))
    throw new Error('模型未完成相同的测速内容，本次不参与排名。');
  return {
    firstTokenMs: Math.round(firstTokenMs),
    totalMs: Math.round(now() - start),
    outputTokens: tokens,
    returnedServiceTier: tier,
  };
}
class RelayBenchmark {
  constructor({
    getProfiles,
    getParameters,
    transport,
    onChange = () => {},
    timeoutMs = 120000,
    measureOne = measure,
  }) {
    Object.assign(this, {
      getProfiles,
      getParameters,
      transport,
      onChange,
      timeoutMs,
      measureOne,
    });
    this.state = {
      busy: false,
      parameters: null,
      rows: [],
      winnerId: null,
      startedAt: null,
      completedAt: null,
    };
  }
  status() {
    return structuredClone(this.state);
  }
  publish() {
    this.onChange(this.status());
  }
  cancel() {
    if (!this.state.busy) return false;
    this.controller.abort(new Error('测速已取消。'));
    return true;
  }
  async run() {
    if (this.state.busy) throw new Error('正在测速，请等待完成或先取消。');
    const profiles = this.getProfiles().map((p) => ({ ...p }));
    if (!profiles.length) throw new Error('请先保存中转配置。');
    const parameters = { ...this.getParameters() },
      secrets = profiles.map((p) => p.apiKey).filter(Boolean);
    this.controller = new AbortController();
    this.state = {
      busy: true,
      parameters,
      rows: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        status: 'running',
        firstTokenMs: null,
        totalMs: null,
        error: null,
      })),
      winnerId: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.publish();
    try {
      await Promise.all(
        profiles.map(async (profile, index) => {
          const row = this.state.rows[index],
            controller = new AbortController();
          const stop = () => controller.abort(new Error('测速已取消。'));
          this.controller.signal.addEventListener('abort', stop, {
            once: true,
          });
          const timer = setTimeout(
            () => controller.abort(new Error('超过 120 秒未完成。')),
            this.timeoutMs,
          );
          try {
            if (!profile.apiKey) throw new Error('未配置 API Key。');
            const result = await this.measureOne(profile, parameters, {
              transport: this.transport,
              signal: controller.signal,
              onFirstToken: (ms) => {
                row.firstTokenMs = Math.round(ms);
                this.publish();
              },
            });
            Object.assign(row, result, { status: 'success' });
          } catch (error) {
            row.status = this.controller.signal.aborted ? 'cancelled' : 'error';
            row.error = redact(
              controller.signal.aborted
                ? controller.signal.reason?.message || '测速已停止。'
                : error.message,
              secrets,
            ).slice(0, 300);
          } finally {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', stop);
            this.publish();
          }
        }),
      );
      const success = this.state.rows
        .filter((r) => r.status === 'success')
        .sort((a, b) => a.totalMs - b.totalMs);
      this.state.winnerId = success[0]?.id || null;
    } finally {
      this.state.busy = false;
      this.state.completedAt = Date.now();
      this.publish();
    }
    return this.status();
  }
}
module.exports = { RelayBenchmark, measure, benchmarkRequest, PROMPT };
