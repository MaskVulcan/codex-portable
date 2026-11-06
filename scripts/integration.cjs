'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { CodexRpc, instructions } = require('../src/core.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-output', 'live');
fs.mkdirSync(out, { recursive: true });
const settings = JSON.parse(
  fs.readFileSync(path.join(root, 'payload', 'provisioning.json'), 'utf8'),
);
const home = path.join(out, 'codex-home');
const work = path.join(out, '中文 工作目录');
fs.mkdirSync(work, { recursive: true });
const python = require('./test-env.cjs').python;
const marker = 'PORTABLE_' + Date.now();
let rpc,
  events = [],
  messages = [];
function client() {
  const c = new CodexRpc({
    executable: process.env.TEST_CODEX || require('./test-env.cjs').codex,
    home,
    settings,
    env: { PYTHONUTF8: '1' },
    log: () => {},
  });
  c.on('notification', ({ method, params }) => {
    events.push(method);
    if (method === 'item/completed' && params.item?.type === 'agentMessage')
      messages.push(params.item.text);
    if (method === 'item/completed') console.log('item:', params.item?.type);
  });
  return c;
}
async function turn(threadId, text) {
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.removeListener('notification', listener);
      reject(new Error('Integration turn timed out'));
    }, 300000);
    const listener = ({ method, params }) => {
      if (method === 'turn/completed' && params.threadId === threadId) {
        clearTimeout(timer);
        rpc.removeListener('notification', listener);
        if (params.turn.status === 'failed')
          reject(new Error(params.turn.error?.message || 'Turn failed'));
        else resolve(params.turn);
      }
    };
    rpc.on('notification', listener);
  });
  await rpc.request(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'low',
    },
    90000,
  );
  return done;
}
(async () => {
  rpc = client();
  await rpc.start();
  console.log('Handshake OK');
  const output = path.join(work, '输出');
  fs.mkdirSync(output, { recursive: true });
  const { thread } = await rpc.request('thread/start', {
    cwd: work,
    model: settings.model,
    modelProvider: 'portable_relay',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    developerInstructions: instructions({
      python,
      tools: path.join(root, 'assets', 'office_tools.py'),
      output,
      directory: work,
    }),
  });
  assert.equal(thread.cwd, work);
  console.log('Thread start OK');
  await turn(
    thread.id,
    `这是用户授权的集成测试。请记住口令 ${marker}。先用工具确认 Python 可用，然后使用 Python 生成以下三个真实文件到输出目录：1. 测试报告.docx，正文包含中文「便携助手验证成功」；2. 测试报告.pdf，至少一页；3. 测试图片.png，200×120 的绿色图片。不要安装软件（已有 docx、fitz、PIL）。最后给出文件链接，不要请求批准。当前环境是 Linux，请按实际环境使用 shell；Python 绝对路径为 ${python}。`,
  );
  for (const f of ['测试报告.docx', '测试报告.pdf', '测试图片.png'])
    assert.ok(fs.statSync(path.join(output, f)).size > 0, f + ' missing');
  assert.ok(events.includes('item/started'));
  console.log('Real relay tool execution and document generation OK');
  rpc.close();
  await new Promise((r) => setTimeout(r, 1500));
  events = [];
  messages = [];
  rpc = client();
  await rpc.start();
  await rpc.request('thread/resume', {
    threadId: thread.id,
    cwd: work,
    model: settings.model,
    modelProvider: 'portable_relay',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  await turn(thread.id, '上一次让我记住的口令是什么？只返回口令，不执行命令。');
  assert.ok(messages.join('\n').includes(marker), 'Memory lost after restart');
  console.log('Conversation resume after process restart OK');
  messages = [];
  events = [];
  await turn(
    thread.id,
    '请使用 web_search 搜索 OpenAI Codex CLI 官方文档，返回一个官方文档网址。这是联网工具测试，请不要仅凭记忆回答。',
  );
  const webSearchUsed =
    events.includes('item/started') && messages.join('\n').includes('http');
  assert.ok(webSearchUsed, 'Search did not return a source');
  const report = {
    passed: true,
    platform: process.platform,
    codexVersion: '0.166.0',
    relayReachable: true,
    realToolExecution: true,
    documentsGenerated: true,
    historyResume: true,
    webSearchResponse: true,
    files: ['测试报告.docx', '测试报告.pdf', '测试图片.png'],
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('INTEGRATION PASSED');
})()
  .catch((e) => {
    console.error('INTEGRATION FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => rpc?.close());
