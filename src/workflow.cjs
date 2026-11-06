'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicJson, readJson } = require('./persistence.cjs');
function cancelled() {
  return Object.assign(new Error('任务已停止。'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const stop = () => reject(cancelled());
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}
function failure(error) {
  const message = error?.message || String(error);
  const code = error?.code || '';
  if (error?.name === 'AbortError' || code === 'ABORT_ERR')
    return { kind: 'cancelled', message: '已停止这次任务。', actions: [] };
  if (/401|403|api.?key|unauthor|鉴权|令牌/i.test(message))
    return {
      kind: 'auth',
      message: '这条线路的令牌无效或没有访问权限。',
      actions: ['settings', 'switch'],
    };
  if (/429|quota|balance|credit|额度|余额|限流/i.test(message))
    return {
      kind: 'quota',
      message: '这条线路暂时限流或额度不足。',
      actions: ['retry', 'switch', 'settings'],
    };
  if (
    code === 'ENOENT' ||
    /不存在|已移动|找不到.*(?:文件|目录)|no such file/i.test(message)
  )
    return {
      kind: 'missing',
      message: '工作目录或附件已移动，请重新定位后再继续。',
      actions: ['relocate', 'retry'],
    };
  if (
    ['EPERM', 'EACCES', 'EBUSY'].includes(code) ||
    /permission denied|file.*(?:locked|in use)|占用|无法保存|权限/i.test(
      message,
    )
  )
    return {
      kind: 'file',
      message:
        '文件暂时无法读写。请关闭占用它的 WPS/其他程序，或更换可写位置。',
      actions: ['retry', 'relocate'],
    };
  if (
    /unsupported|not support|model.*not found|不支持|格式|模型.*可用/i.test(
      message,
    )
  )
    return {
      kind: 'unsupported',
      message:
        '当前线路或文件格式不支持这次操作，请更换模型/线路，或把文档另存为 DOCX/PDF。',
      actions: ['settings', 'switch'],
    };
  if (
    /timeout|timed out|network|fetch failed|socket|ECONN|ENOTFOUND|断开|连接|超时/i.test(
      message,
    )
  )
    return {
      kind: 'network',
      message: '连接中断或等待超时。已保留请求和附件，可重试或换线路。',
      actions: ['retry', 'switch', 'diagnostics'],
    };
  return {
    kind: 'other',
    message: '本次操作未完成。请求和文件仍保留，可重试或导出诊断。',
    actions: ['retry', 'diagnostics'],
  };
}
class WorkspaceState {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'workspace.json');
    this.value = readJson(this.file, {
      drafts: {},
      onboarded: false,
      trayExplained: false,
    });
    this.value.drafts ||= {};
  }
  draft(id) {
    return structuredClone(
      this.value.drafts[id] || { text: '', attachments: [], revision: 0 },
    );
  }
  saveDraft(id, draft) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))
      throw new Error('无效草稿。');
    const next = {
      text: String(draft.text || '').slice(0, 200000),
      attachments: Array.isArray(draft.attachments)
        ? draft.attachments.slice(0, 100)
        : [],
      revision: (this.value.drafts[id]?.revision || 0) + 1,
    };
    this.value.drafts[id] = next;
    atomicJson(this.file, this.value);
    return this.draft(id);
  }
  clearDraft(id) {
    return this.saveDraft(id, { text: '', attachments: [] });
  }
  preference(update) {
    for (const k of ['onboarded', 'trayExplained'])
      if (typeof update[k] === 'boolean') this.value[k] = update[k];
    atomicJson(this.file, this.value);
    return {
      onboarded: this.value.onboarded,
      trayExplained: this.value.trayExplained,
    };
  }
}
async function snapshotInputs(root, task, attachments, signal) {
  const result = [],
    base = path.join(root, 'originals', task.id);
  await fs.promises.mkdir(base, { recursive: true });
  for (let i = 0; i < attachments.length; i++) {
    signal?.throwIfAborted();
    const a = attachments[i],
      original = path.join(base, String(i) + '-' + path.basename(a.path)),
      copy = path.join(
        task.output,
        '.work',
        'inputs',
        String(i) + '-' + path.basename(a.path),
      );
    await fs.promises.mkdir(path.dirname(copy), { recursive: true });
    await fs.promises.copyFile(a.path, original);
    signal?.throwIfAborted();
    await fs.promises.copyFile(original, copy);
    result.push({
      ...a,
      sourcePath: a.path,
      originalPath: original,
      path: copy,
    });
  }
  return result;
}
async function filesUnder(dir) {
  const result = [];
  async function walk(folder, depth) {
    if (depth > 7 || result.length > 1000) return;
    let list;
    try {
      list = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (
        e.isSymbolicLink() ||
        e.name.startsWith('.') ||
        e.name === '__pycache__'
      )
        continue;
      const file = path.join(folder, e.name);
      if (e.isDirectory()) await walk(file, depth + 1);
      else if (e.isFile()) {
        const s = await fs.promises.stat(file);
        result.push({
          name: e.name,
          path: file,
          relative: path.relative(dir, file),
          size: s.size,
          modified: s.mtimeMs,
        });
      }
    }
  }
  await walk(dir, 0);
  return result;
}
async function validateOutputs(task, python, tools, signal) {
  const files = await filesUnder(task.output);
  if (!files.length) return [];
  const response = await new Promise((resolve) => {
    const p = spawn(python, [tools, 'validate', ...files.map((f) => f.path)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let text = '',
      timer = setTimeout(() => {
        p.kill();
        resolve(null);
      }, 45000);
    const stop = () => {
      p.kill();
      clearTimeout(timer);
      resolve(null);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    p.on('error', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(null);
    });
    p.stdout.on('data', (b) => {
      text += b.toString();
      if (text.length > 2 * 1024 * 1024) p.kill();
    });
    p.stderr.resume();
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      try {
        resolve(code === 0 ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
  });
  return files.map((f) => ({
    ...f,
    validation: response?.find((v) => v.path === f.path) || {
      valid: f.size > 0,
      checked: '存在且非空',
      warning: '未能完成格式检查',
    },
  }));
}
function taskOutcome(task, status) {
  if (status === 'interrupted') return '已停止';
  if (status === 'failed') return '处理失败';
  if (!task.artifacts?.length) return '已回答';
  if (task.artifacts.some((f) => !f.validation?.valid)) return '部分完成';
  return '已生成文件';
}
function newTask(chat, text, attachments) {
  const id = crypto.randomUUID(),
    date = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
  const title = (text || attachments[0]?.name || '文件处理')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 25);
  return {
    id,
    title,
    request: text,
    sourceFiles: attachments.map((a) => ({ ...a })),
    output: path.join(
      chat.directory,
      '输出',
      date + '-' + title + '-' + id.slice(0, 6),
    ),
    startedAt: Date.now(),
    phase: '准备文件',
    status: 'running',
    artifacts: [],
    originals: [],
  };
}
module.exports = {
  WorkspaceState,
  abortable,
  cancelled,
  failure,
  snapshotInputs,
  filesUnder,
  validateOutputs,
  taskOutcome,
  newTask,
};
