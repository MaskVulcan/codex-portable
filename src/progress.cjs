'use strict';
const { redact } = require('./core.cjs');
const clean = (s, secrets) =>
  redact(String(s || ''), secrets)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(-2000);
function updateProgress(chat, method, p, secrets = []) {
  const task = chat.tasks?.at(-1);
  if (!task) return false;
  const progress = (task.progress ||= { updatedAt: Date.now(), errors: 0 });
  progress.errors ||= 0;
  progress.updatedAt = Date.now();
  if (method === 'turn/plan/updated') {
    progress.plan = (p.plan || []).slice(0, 15).map((v) => ({
      step: clean(v.step, secrets).slice(0, 200),
      status: v.status,
    }));
    progress.detail = clean(p.explanation, secrets);
    return true;
  }
  if (method === 'item/commandExecution/outputDelta') {
    const a = chat.activity.find((a) => a.id === p.itemId);
    if (a) a.output = clean((a.output || '') + p.delta, secrets).slice(-12000);
    progress.detail =
      clean(p.delta, secrets)
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1)
        ?.slice(0, 240) || progress.detail;
    return true;
  }
  if (method === 'item/mcpToolCall/progress') {
    progress.detail = clean(p.message, secrets).slice(0, 240);
    return true;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = p.item || {};
    if (
      method === 'item/completed' &&
      ((typeof item.exitCode === 'number' && item.exitCode !== 0) ||
        item.status === 'failed')
    ) {
      progress.errors++;
      progress.lastError = clean(
        item.error?.message ||
          item.aggregatedOutput ||
          item.output ||
          '工具操作失败',
        secrets,
      ).slice(-500);
    }
    const labels = {
      commandExecution: /playwright|browser|chrome|edge|selenium/i.test(
        item.command || '',
      )
        ? '正在操作浏览器'
        : '正在执行脚本',
      webSearch: '正在搜索网页',
      mcpToolCall: (item.server || '').includes('browser')
        ? '正在操作用户浏览器'
        : '正在使用工具',
      dynamicToolCall: '正在使用工具',
      fileChange: '正在保存文件',
      reasoning: '正在思考',
    };
    if (labels[item.type]) progress.headline = labels[item.type];
    if (method === 'item/completed')
      progress.detail =
        progress.lastError && item.status === 'failed'
          ? progress.lastError.slice(-240)
          : '上一步已返回，等待下一步';
  }
  return false;
}
module.exports = { updateProgress };
