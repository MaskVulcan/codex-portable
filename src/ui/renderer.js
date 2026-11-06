'use strict';
const api = window.portable;
const $ = (id) => document.getElementById(id);
const state = {
  settings: {},
  chats: [],
  chat: null,
  attachments: [],
  files: [],
  outputs: [],
  filesMode: 'outputs',
  mentionIndex: 0,
  mentions: [],
  renameId: null,
  stick: true,
  renderTimer: null,
  cli: null,
  benchmark: null,
  pet: null,
  editingProfileId: null,
  draftModels: null,
  imports: 0,
  archived: false,
  sending: false,
  draftTimers: new Map(),
  localDrafts: new Map(),
  switchSequence: 0,
};
const welcome = $('welcome').cloneNode(true);
let toastTimer,
  dropDepth = 0,
  mentionQuery = 0;
function toast(message) {
  $('toast').textContent = String(message).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6500);
}
async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return null;
  }
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function icon(name) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('class', 'i');
  n.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-' + name);
  n.append(use);
  return n;
}
function basename(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
function size(bytes) {
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + ' MB'
    : bytes >= 1024
      ? Math.round(bytes / 1024) + ' KB'
      : bytes + ' B';
}
function date(time) {
  const d = new Date(time);
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
const defaultModels = [
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
];
function modelsFor(profile) {
  return profile?.models?.length
    ? profile.models
    : state.settings.modelOptions || defaultModels;
}
function modelOptions(select, models, current) {
  const list = [...new Set(models || defaultModels)];
  if (current && !list.includes(current)) list.push(current);
  select.replaceChildren();
  for (const [label, match] of [
    ['GPT-6.1', (m) => m.startsWith('gpt-6.1')],
    ['GPT-6', (m) => m.startsWith('gpt-6') && !m.startsWith('gpt-6.1')],
    ['当前设置', (m) => !m.startsWith('gpt-6')],
  ]) {
    const items = list.filter(match);
    if (!items.length) continue;
    const group = el('optgroup');
    group.label = label;
    for (const name of items) {
      const option = el('option', '', name);
      option.value = name;
      group.append(option);
    }
    select.append(group);
  }
  if (current) select.value = current;
}
function profileOptions(select, selected, includeNew = false) {
  select.replaceChildren();
  for (const p of state.settings.profiles || []) {
    const option = el('option', '', p.name);
    option.value = p.id;
    select.append(option);
  }
  if (includeNew) {
    const option = el('option', '', '新增配置…');
    option.value = '__new__';
    select.append(option);
  }
  select.value =
    selected === null ? '__new__' : selected || state.settings.activeProfileId;
}
function html(text) {
  return DOMPurify.sanitize(
    marked.parse(text || '', { breaks: true, gfm: true }),
    {
      FORBID_TAGS: [
        'img',
        'video',
        'audio',
        'iframe',
        'style',
        'form',
        'input',
        'button',
      ],
      FORBID_ATTR: ['style', 'onerror', 'id', 'name'],
      ALLOW_UNKNOWN_PROTOCOLS: true,
    },
  );
}
function nearBottom() {
  const n = $('messages');
  return n.scrollHeight - n.scrollTop - n.clientHeight < 110;
}
function bottom(force = false) {
  if (force || state.stick) {
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}
function renderHistory() {
  const query = $('history-search').value.toLowerCase();
  const rows = state.chats.filter((c) => c.title.toLowerCase().includes(query));
  const host = $('history');
  host.replaceChildren();
  $('history-count').textContent = state.chats.length;
  if (!rows.length) {
    host.append(
      el(
        'div',
        'history-empty',
        query
          ? '没有找到匹配的对话'
          : '从一个文件夹开始，\n你的对话会保存在这里。',
      ),
    );
    return;
  }
  for (const chat of rows) {
    const row = el(
      'div',
      'history-row' + (chat.id === state.chat?.id ? ' selected' : ''),
    );
    const button = el('button', 'history-item');
    button.title = chat.directory;
    button.append(
      el(
        'span',
        'history-title',
        (chat.pendingQuestions ? '等你回答 · ' : chat.busy ? '◦ ' : '') +
          chat.title,
      ),
      el(
        'span',
        'history-meta',
        basename(chat.directory) + ' · ' + date(chat.updatedAt),
      ),
    );
    button.onclick = () =>
      attempt(async () => {
        if (state.archived) {
          await api.restoreChat(chat.id);
          state.archived = false;
          state.chats = await api.listChats();
          $('history-mode').value = 'active';
        }
        await openChat(chat.id);
      });
    const more = el('button', 'history-menu', '⋯');
    more.title = '对话操作';
    more.onclick = (e) => {
      e.stopPropagation();
      contextMenu(e, chat);
    };
    row.append(button, more);
    host.append(row);
  }
}
function contextMenu(event, chat) {
  document.querySelector('.history-context')?.remove();
  const menu = el('div', 'history-context');
  menu.style.left = Math.min(event.clientX, window.innerWidth - 150) + 'px';
  menu.style.top = event.clientY + 'px';
  for (const [label, action] of [
    [
      '重命名',
      () => {
        state.renameId = chat.id;
        $('rename-title').value = chat.title;
        $('rename-dialog').showModal();
        $('rename-title').select();
      },
    ],
    [
      '移至归档',
      async () => {
        await api.archiveChat(chat.id);
        if (state.chat?.id === chat.id) {
          state.chat = null;
          state.attachments = [];
          renderAll();
        }
        state.chats = await api.listChats();
        renderHistory();
      },
    ],
  ]) {
    const b = el('button', '', label);
    b.onclick = () => {
      menu.remove();
      attempt(action);
    };
    menu.append(b);
  }
  document.body.append(menu);
  setTimeout(
    () =>
      document.addEventListener('click', () => menu.remove(), { once: true }),
    0,
  );
}
function thumbnail(file) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(file.thumbnail || ''))
    return null;
  const img = el('img', 'attachment-thumbnail');
  img.src = file.thumbnail;
  img.alt = file.name;
  return img;
}
function renderAttachments() {
  const host = $('attachment-list');
  host.replaceChildren();
  state.attachments.forEach((f, i) => {
    const chip = el('div', 'attachment-chip');
    chip.title = f.path;
    const preview = thumbnail(f);
    if (preview) chip.append(preview);
    chip.append(
      el('span', '', (preview ? '' : f.image ? '▧ ' : '▤ ') + f.name),
    );
    const remove = el('button', '', '×');
    remove.title = '移除附件';
    remove.onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachments();
      queueDraft();
    };
    chip.append(remove);
    host.append(chip);
  });
}
function renderHeader() {
  $('directory-label').textContent = state.chat
    ? basename(state.chat.directory)
    : '选择工作文件夹';
  $('directory').title = state.chat?.directory || '选择工作文件夹';
  const profile = state.settings.profiles?.find(
    (p) => p.id === state.settings.activeProfileId,
  );
  modelOptions($('model-label'), modelsFor(profile), state.settings.model);
  profileOptions($('profile-switch'), state.settings.activeProfileId);
  $('profile-switch').title = profile?.name || '切换中转配置';
  const effortNames = {
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
  };
  $('effort-label').textContent =
    '思考：' + (effortNames[state.settings.reasoningEffort] || '极高');
  $('fast-toggle').textContent =
    'Fast ' + (state.settings.fastMode !== false ? '开' : '关');
  $('fast-toggle').classList.toggle(
    'enabled',
    state.settings.fastMode !== false,
  );
  $('fast-toggle').setAttribute(
    'aria-pressed',
    String(state.settings.fastMode !== false),
  );
  const busy = !!state.chat?.busy;
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
  $('activity-status').classList.toggle('hidden', !busy && !state.imports);
  $('activity-text').textContent = state.imports
    ? '正在添加图片…'
    : state.chat?.status || '正在处理';
  const updating = !!state.cli?.busy || !!state.benchmark?.busy;
  $('prompt').disabled = busy || updating;
  $('attach').disabled = busy || updating;
  $('mention').disabled = busy || updating;
  $('fast-toggle').disabled = busy || updating;
  $('send').disabled = updating || state.imports > 0 || state.sending;
  $('model-label').disabled = busy || updating;
  $('profile-switch').disabled = state.chats.some((c) => c.busy) || updating;
  $('export').disabled = !state.chat?.messages.length;
  renderCli();
  renderBenchmark();
}
function duration(ms) {
  return typeof ms === 'number' ? (ms / 1000).toFixed(2) + ' s' : '—';
}
function renderBenchmark() {
  const result = state.benchmark || {},
    busy = !!result.busy,
    blocked = state.chats.some((c) => c.busy) || !!state.cli?.busy;
  $('benchmark-open').disabled = busy || blocked;
  $('benchmark-settings').disabled = busy || blocked;
  $('benchmark-rerun').disabled = busy || blocked;
  $('benchmark-cancel').classList.toggle('hidden', !busy);
  const params = result.parameters || state.settings;
  $('benchmark-parameters').textContent =
    (params.model || 'gpt-6.1-sol') +
    ' · ' +
    (params.reasoningEffort || 'xhigh') +
    ' · ' +
    (params.fastMode !== false ? 'Fast' : '标准速度');
  const host = $('benchmark-results');
  host.replaceChildren();
  const statuses = {
    running: '测速中…',
    success: '成功',
    error: '失败',
    cancelled: '已取消',
  };
  for (const row of result.rows || []) {
    const tr = el('tr');
    tr.append(
      el('td', '', row.name),
      el('td', '', duration(row.firstTokenMs)),
      el('td', '', duration(row.totalMs)),
    );
    const status = el(
      'td',
      row.status === 'error' ? 'failure' : '',
      statuses[row.status] || row.status,
    );
    if (row.id === result.winnerId)
      status.append(el('span', 'benchmark-fastest', '最快'));
    if (row.error) {
      const small = el('small', 'benchmark-error', row.error);
      status.append(small);
    }
    tr.append(status);
    const actions = el('td');
    if (row.status === 'success' && !busy) {
      const use = el(
        'button',
        'text-button',
        row.id === state.settings.activeProfileId ? '当前' : '使用',
      );
      use.disabled = row.id === state.settings.activeProfileId;
      use.onclick = () =>
        attempt(async () => {
          state.settings = await api.selectProfile(row.id);
          renderHeader();
          toast('已切换到 ' + row.name);
        });
      actions.append(use);
    }
    tr.append(actions);
    host.append(tr);
  }
  const winner = result.rows?.find((r) => r.id === result.winnerId);
  $('benchmark-summary').textContent = busy
    ? '正在用相同请求对比所有已保存线路…'
    : winner
      ? '本次完成最快：' +
        winner.name +
        '。首字越短，开始回复越快；完成时间越短，本次任务越快。'
      : result.rows?.length
        ? '测速已结束，请查看各线路结果。'
        : '每条已保存线路会发送一次简短模型请求，比较首字和总耗时。';
}
async function runBenchmark() {
  if (!$('benchmark-dialog').open) $('benchmark-dialog').showModal();
  try {
    state.benchmark = await api.benchmarkRun();
  } finally {
    renderHeader();
  }
}
function renderCli() {
  const c = state.cli || {};
  $('cli-current').textContent = c.currentVersion
    ? 'v' + c.currentVersion
    : '读取版本…';
  $('cli-message').textContent =
    c.message || '从官方发布页更新，保留你的对话与工具。';
  $('cli-message').classList.toggle('failure', c.phase === 'error');
  $('cli-check').disabled = !!c.busy || !!state.benchmark?.busy;
  $('cli-update').disabled =
    !!c.busy ||
    !!state.benchmark?.busy ||
    !c.updateAvailable ||
    state.chats.some((c) => c.busy);
  $('cli-update').textContent = c.updateAvailable
    ? '更新至 ' + c.latestVersion
    : '一键更新';
  $('cli-rollback').disabled =
    !!c.busy ||
    !!state.benchmark?.busy ||
    !c.previousVersion ||
    state.chats.some((c) => c.busy);
  $('cli-rollback').textContent = c.previousVersion
    ? '恢复 ' + c.previousVersion
    : '恢复上一版';
  $('cli-cancel').classList.toggle(
    'hidden',
    !c.busy ||
      !['checking', 'downloading', 'extracting', 'testing'].includes(c.phase),
  );
  const progress = $('cli-progress');
  progress.classList.toggle('hidden', !c.busy);
  if (c.total && c.bytes) {
    progress.max = c.total;
    progress.value = c.bytes;
  } else progress.removeAttribute('value');
}
function renderMessages() {
  const scroll = $('messages').scrollTop;
  const host = $('messages');
  host.replaceChildren();
  if (!state.chat?.messages.length) {
    const w = welcome.cloneNode(true);
    host.append(w);
    w.querySelector('#choose-hint').classList.toggle('hidden', !!state.chat);
    w.querySelector('#welcome-directory').onclick = () =>
      attempt(chooseDirectory);
    for (const b of w.querySelectorAll('[data-prompt]'))
      b.onclick = () => {
        $('prompt').value = b.dataset.prompt;
        $('prompt').focus();
      };
  }
  for (const m of state.chat?.messages || []) {
    const item = el('article', 'message ' + m.role);
    item.dataset.messageId = m.id;
    if (m.role === 'user') {
      if (m.text) item.append(el('div', 'user-bubble', m.text));
      if (m.attachments?.length) {
        const files = el('div', 'user-attachments');
        for (const f of m.attachments) {
          const b = el('button', 'message-file');
          b.append(
            thumbnail(f) || icon('document'),
            document.createTextNode(f.name),
          );
          b.title = f.path;
          b.onclick = () => attempt(() => api.open(f.path, state.chat.id));
          files.append(b);
        }
        item.append(files);
      }
    } else if (m.role === 'error') {
      const problem = m.friendly || state.chat.failure;
      item.append(el('div', '', problem?.message || m.text));
      const options = problem?.actions || ['retry', 'diagnostics'];
      for (const action of options) {
        const labels = {
          retry: '重试这次任务',
          switch: '换线路重试',
          settings: '连接设置',
          relocate: '重新定位工作目录',
          diagnostics: '导出诊断',
        };
        const b = el('button', '', labels[action]);
        b.onclick = () => attempt(() => recover(action));
        item.append(b);
      }
      const details = el('details', '');
      details.append(el('summary', '', '错误详情'), el('code', '', m.text));
      item.append(details);
    } else {
      const meta = el('div', 'assistant-meta');
      meta.append(icon('spark'), document.createTextNode('Codex'));
      item.append(meta);
      const body = el('div', 'markdown');
      body.innerHTML = html(m.text || (m.streaming ? '…' : ''));
      item.append(body);
      if (m.text && !m.streaming) {
        const actions = el('div', 'message-tools');
        const copy = el('button', '', '复制');
        copy.onclick = () =>
          attempt(async () => {
            await navigator.clipboard.writeText(m.text);
            toast('已复制');
          });
        actions.append(copy);
        item.append(actions);
      }
    }
    host.append(item);
  }
  if (state.chat?.activity.length) {
    const details = el('details', 'activity-details');
    details.open = !!state.detailsOpen;
    details.ontoggle = () => {
      state.detailsOpen = details.open;
    };
    details.append(
      el('summary', '', `查看处理过程 · ${state.chat.activity.length} 项`),
    );
    for (const a of state.chat.activity.slice(-35)) {
      const row = el('div', 'activity-entry');
      const names = {
        commandExecution: '执行脚本',
        fileChange: '保存文件',
        webSearch: '联网搜索',
        imageView: '查看图片',
        reasoning: '思考',
        plan: '安排步骤',
        mcpToolCall: '使用工具',
        dynamicToolCall: '使用工具',
      };
      row.append(
        el(
          'span',
          'activity-label',
          (a.done ? '✓ ' : '◦ ') +
            (names[a.type] || '处理') +
            (a.exitCode ? `（返回 ${a.exitCode}）` : ''),
        ),
      );
      if (a.command || a.query)
        row.append(el('code', '', a.command || a.query));
      if (a.output) row.append(el('code', '', a.output));
      if (a.changes?.length) row.append(el('code', '', a.changes.join('\n')));
      details.append(row);
    }
    host.append(details);
  }
  for (const task of (state.chat?.tasks || []).filter(
    (t) => t.status !== 'running',
  )) {
    const card = el('div', 'result-card');
    card.append(
      el(
        'strong',
        '',
        task.artifacts?.length
          ? '本次生成 ' + task.artifacts.length + ' 个文件'
          : task.status === 'interrupted'
            ? '任务已停止'
            : task.status === 'failed'
              ? '任务未完成'
              : '本次已回答',
      ),
      el('small', '', task.title),
    );
    if (task.artifacts?.length) {
      for (const file of task.artifacts) {
        const row = el('div', 'result-row'),
          open = el('button', 'file-name', file.name);
        open.onclick = () => attempt(() => api.open(file.path, state.chat.id));
        row.append(
          open,
          el(
            'span',
            'validation',
            file.validation?.valid
              ? '✓ ' + (file.validation.checked || '文件可读取')
              : '需检查：' + (file.validation?.error || '未通过检查'),
          ),
        );
        const save = el('button', 'text-button', '另存为');
        save.onclick = () =>
          attempt(async () => {
            const p = await api.saveResult(state.chat.id, task.id, file.path);
            if (p) toast('已保存：' + p);
          });
        row.append(save);
        card.append(row);
      }
      const zip = el('button', 'secondary-button', '打包本次文件');
      zip.onclick = () =>
        attempt(async () => {
          const p = await api.zipResults(state.chat.id, task.id);
          if (p) toast('已打包：' + p);
        });
      card.append(zip);
    }
    if (task.originals?.length) {
      const d = el('details', 'originals');
      d.append(el('summary', '', '原件快照（' + task.originals.length + '）'));
      task.originals.forEach((o, i) => {
        const b = el('button', 'text-button', '恢复原件副本：' + o.name);
        b.onclick = () =>
          attempt(async () => {
            const p = await api.restoreOriginal(state.chat.id, task.id, i);
            if (p) toast('原件已恢复：' + p);
          });
        d.append(b);
      });
      card.append(d);
    }
    host.append(card);
  }
  if (state.stick) bottom();
  else host.scrollTop = scroll;
}
function renderFiles() {
  const host = $('files');
  host.replaceChildren();
  const files = state.filesMode === 'outputs' ? state.outputs : state.files;
  $('outputs-tab').classList.toggle('selected', state.filesMode === 'outputs');
  $('all-files-tab').classList.toggle('selected', state.filesMode === 'all');
  if (!files.length) {
    const empty = el('div', 'files-empty');
    empty.append(icon('folder'));
    const p = el(
      'p',
      '',
      state.filesMode === 'outputs'
        ? '完成任务后，\n在这里打开处理结果。'
        : state.chat
          ? '这个文件夹中还没有文件。'
          : '先选择一个工作文件夹。',
    );
    p.style.whiteSpace = 'pre-line';
    empty.append(p);
    host.append(empty);
    return;
  }
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const row = el('div', 'file-row');
    row.title = file.relative;
    const icon = el('div', 'file-type ' + ext, ext.toUpperCase().slice(0, 4));
    const info = el('div', 'file-info');
    const name = el('button', 'file-name', file.name);
    name.onclick = () => attempt(() => api.open(file.path, state.chat.id));
    info.append(name, el('div', 'file-size', size(file.size)));
    const add = el('button', 'file-add', '＋');
    add.title = '添加到消息';
    add.onclick = () => attempt(() => addFiles([file.path]));
    row.append(icon, info, add);
    host.append(row);
  }
}
function renderAll() {
  renderHistory();
  renderHeader();
  renderMessages();
  renderAttachments();
  renderFiles();
  renderQuestions();
}
async function refreshFiles() {
  if (!state.chat) {
    state.files = [];
    state.outputs = [];
    renderFiles();
    return;
  }
  const id = state.chat.id;
  const [files, outputs] = await Promise.all([
    api.listFiles(id),
    api.outputFiles(id),
  ]);
  if (state.chat?.id !== id) return;
  state.files = files;
  state.outputs = outputs;
  renderFiles();
}
function draftId() {
  return state.chat?.id || 'new';
}
function queueDraft() {
  const id = draftId(),
    draft = {
      text: $('prompt').value,
      attachments: structuredClone(state.attachments),
    };
  state.localDrafts.set(id, draft);
  clearTimeout(state.draftTimers.get(id));
  state.draftTimers.set(
    id,
    setTimeout(() => {
      state.draftTimers.delete(id);
      attempt(() => api.saveDraft(id, draft));
    }, 250),
  );
}
async function flushDraft() {
  const id = draftId();
  clearTimeout(state.draftTimers.get(id));
  state.draftTimers.delete(id);
  const value = {
    text: $('prompt').value,
    attachments: structuredClone(state.attachments),
  };
  state.localDrafts.set(id, value);
  await api.saveDraft(id, value);
}
async function restoreDraft(id) {
  const draft = state.localDrafts.get(id) || (await api.getDraft(id));
  $('prompt').value = draft.text || '';
  state.attachments = draft.attachments || [];
  renderAttachments();
}
async function openChat(id) {
  const sequence = ++state.switchSequence;
  await flushDraft();
  const chat = await api.getChat(id);
  if (sequence !== state.switchSequence) return;
  const draft = state.localDrafts.get(id) || (await api.getDraft(id));
  if (sequence !== state.switchSequence) return;
  state.chat = chat;
  $('prompt').value = draft.text || '';
  state.attachments = draft.attachments || [];
  state.stick = true;
  state.detailsOpen = false;
  renderAll();
  renderQuestions();
  await refreshFiles();
  bottom(true);
}
async function create(directory) {
  await flushDraft();
  state.chat = await api.createChat(directory);
  state.chats = await api.listChats();
  state.attachments = [];
  $('prompt').value = '';
  state.stick = true;
  state.detailsOpen = false;
  renderAll();
  renderQuestions();
  await refreshFiles();
  $('prompt').focus();
}
async function chooseDirectory() {
  const directory = await api.selectDirectory();
  if (directory) {
    const draft = [...state.attachments];
    await create(directory);
    state.attachments = draft;
    renderAttachments();
  }
}
async function newChat() {
  if (state.chat?.directory) await create(state.chat.directory);
  else if (state.settings.lastDirectory)
    await create(state.settings.lastDirectory);
  else await chooseDirectory();
}
async function addFiles(files) {
  const described = await api.describeFiles(files);
  for (const f of described) {
    if (!state.attachments.some((x) => x.path === f.path))
      state.attachments.push(f);
  }
  renderAttachments();
  queueDraft();
  $('prompt').focus();
}
async function addPastedImages(files) {
  state.imports++;
  renderHeader();
  try {
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024)
        throw new Error('图片超过 32 MB，请保存为文件后添加。');
      const item = await api.importImage(
        new Uint8Array(await file.arrayBuffer()),
        file.name || '截图',
      );
      state.attachments.push(item);
      renderAttachments();
      queueDraft();
    }
    $('prompt').focus();
  } finally {
    state.imports--;
    renderHeader();
  }
}
async function pasteNativeImage() {
  state.imports++;
  renderHeader();
  try {
    const item = await api.pasteImage();
    if (item) {
      state.attachments.push(item);
      renderAttachments();
      queueDraft();
      $('prompt').focus();
    }
  } finally {
    state.imports--;
    renderHeader();
  }
}
async function send() {
  if (state.sending) return;
  if (state.imports) {
    toast('图片正在添加，请稍候再发送。');
    return;
  }
  const text = $('prompt').value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.chat) {
    const draft = { text, attachments: [...state.attachments] };
    await chooseDirectory();
    if (!state.chat) return;
    $('prompt').value = draft.text;
    state.attachments = draft.attachments;
  }
  if (state.chat.busy) return;
  const id = state.chat.id,
    files = state.attachments.map((f) => f.path);
  state.sending = true;
  await flushDraft();
  $('mention-list').classList.add('hidden');
  state.stick = true;
  try {
    const result = await api.send(id, text, files);
    if (result.accepted) {
      state.localDrafts.delete(id);
      if (state.chat?.id === id) {
        $('prompt').value = '';
        $('prompt').style.height = '';
        state.attachments = [];
        renderAttachments();
        await api.saveDraft(id, { text: '', attachments: [] });
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    state.sending = false;
    renderHeader();
  }
}
async function mentions() {
  const input = $('prompt'),
    head = input.value.slice(0, input.selectionStart);
  const match = head.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match || !state.chat) {
    $('mention-list').classList.add('hidden');
    return;
  }
  const seq = ++mentionQuery;
  if (!state.files.length) await refreshFiles();
  if (seq !== mentionQuery) return;
  const query = match[1].toLowerCase();
  state.mentions = state.files
    .filter((f) => f.relative.toLowerCase().includes(query))
    .slice(0, 12);
  state.mentionIndex = 0;
  const host = $('mention-list');
  host.replaceChildren(
    el(
      'div',
      'mention-heading',
      state.mentions.length
        ? '选择要引用的文件'
        : '没有找到文件，可直接拖入文件',
    ),
  );
  state.mentions.forEach((f, i) => {
    const b = el(
      'button',
      'mention-option' + (!i ? ' highlighted' : ''),
      f.relative,
    );
    b.title = f.path;
    b.onclick = () => selectMention(i);
    host.append(b);
  });
  host.classList.remove('hidden');
}
function selectMention(index) {
  const file = state.mentions[index];
  if (!file) return;
  const input = $('prompt'),
    pos = input.selectionStart,
    head = input.value.slice(0, pos),
    tail = input.value.slice(pos);
  input.value = head.replace(/(^|\s)@([^@\n]*)$/, (_, space) => space) + tail;
  $('mention-list').classList.add('hidden');
  attempt(() => addFiles([file.path]));
}
function editProfile(id) {
  const p = state.settings.profiles?.find((p) => p.id === id);
  state.editingProfileId = p ? p.id : null;
  state.draftModels = modelsFor(p);
  profileOptions($('setting-profile'), state.editingProfileId, true);
  $('setting-name').value = p?.name || '自定义中转';
  $('setting-url').value = p?.baseUrl || '';
  $('setting-key').value = '';
  $('setting-key').placeholder = p?.hasApiKey
    ? '已配置；留空保留此配置的 Key'
    : '请输入这套中转的 API Key';
  modelOptions(
    $('setting-model'),
    state.draftModels,
    p?.model || defaultModels[0],
  );
  $('setting-effort').value = p?.reasoningEffort || 'xhigh';
  $('setting-fast').checked = p?.fastMode !== false;
  $('setting-web').checked = p?.webSearch !== false;
  $('settings-result').textContent = '';
  $('profile-delete').disabled =
    !p || (state.settings.profiles?.length || 0) < 2;
}
function openSettings() {
  editProfile(state.settings.activeProfileId);
  renderCli();
  $('settings').showModal();
  attempt(async () => {
    state.cli = await api.cliStatus();
    renderCli();
  });
}
function settingsValues() {
  return {
    profileId: state.editingProfileId,
    name: $('setting-name').value.trim(),
    baseUrl: $('setting-url').value.trim(),
    apiKey: $('setting-key').value.trim(),
    model: $('setting-model').value,
    reasoningEffort: $('setting-effort').value,
    fastMode: $('setting-fast').checked,
    webSearch: $('setting-web').checked,
  };
}
async function saveSettings() {
  state.settings = await api.saveSettings(settingsValues());
  state.editingProfileId = state.settings.activeProfileId;
  profileOptions($('setting-profile'), state.editingProfileId, true);
  $('setting-key').value = '';
  $('setting-key').placeholder = '已配置；留空保留此配置的 Key';
  renderHeader();
  return state.settings;
}
function renderQuestions() {
  const host = $('question-panel');
  host.replaceChildren();
  const pending = state.chat?.pendingQuestions || [];
  host.classList.toggle('hidden', !pending.length);
  if (!pending.length) return;
  const event = pending[0],
    answers = {};
  const questions = event.questions || [];
  for (const q of questions) {
    host.append(el('p', '', q.question || q.header || '请补充信息'));
    const options = el('div', 'question-options');
    const input = el('input');
    input.placeholder = '输入你的回答';
    input.type = q.isSecret ? 'password' : 'text';
    input.dataset.question = q.id;
    for (const option of q.options || []) {
      const b = el('button', '', option.label);
      b.title = option.description || '';
      b.onclick = () => {
        input.value = option.label;
      };
      options.append(b);
    }
    host.append(options, input);
  }
  const button = el('button', 'primary-button', '继续处理');
  button.onclick = () =>
    attempt(async () => {
      for (const q of questions) {
        const input = [...host.querySelectorAll('input')].find(
          (x) => x.dataset.question === q.id,
        );
        if (!input.value.trim()) throw new Error('请回答每个问题。');
        answers[q.id] = { answers: [input.value] };
      }
      await api.answer(event.requestId, answers);
      state.chat.pendingQuestions = state.chat.pendingQuestions.filter(
        (p) => p.requestId !== event.requestId,
      );
      renderQuestions();
    });
  host.append(button);
}
async function recover(action) {
  const id = state.chat?.id;
  if (!id) return;
  if (action === 'settings') {
    openSettings();
    return;
  }
  if (action === 'diagnostics') {
    const p = await api.diagnostics();
    if (p) toast('诊断已保存：' + p);
    return;
  }
  if (action === 'relocate') {
    const chat = await api.relocateChat(id);
    if (chat) {
      state.chat = chat;
      renderAll();
      await refreshFiles();
    }
    return;
  }
  if (action === 'switch') {
    const options = state.settings.profiles.filter(
      (p) => p.id !== state.settings.activeProfileId,
    );
    if (!options.length) {
      openSettings();
      return;
    }
    state.retryId = id;
    $('retry-profiles').replaceChildren(
      ...options.map((p) => {
        const o = el('option', '', p.name);
        o.value = p.id;
        return o;
      }),
    );
    $('retry-dialog').showModal();
    return;
  }
  await api.retry(id);
}
api.onEvent((event) => {
  if (event.type === 'history') {
    if (!state.archived) state.chats = event.chats;
    renderHistory();
    renderCli();
  }
  if (event.type === 'settings') {
    state.settings = event.settings;
    renderHeader();
  }
  if (event.type === 'open-chat') {
    if (event.chatId) attempt(() => openChat(event.chatId));
    else $('prompt').focus();
  }
  if (event.type === 'pet-settings') {
    if (state.pet) state.pet.settings = event.settings;
  }
  if (event.type === 'benchmark') {
    state.benchmark = event.status;
    renderHeader();
  }
  if (event.type === 'cli-update') {
    state.cli = event.status;
    renderHeader();
    $('connection-status').lastChild.textContent = event.status.busy
      ? 'CLI 更新中'
      : '就绪';
  }
  if (event.type === 'chat' && event.chat.id === state.chat?.id) {
    state.stick = nearBottom();
    state.chat = event.chat;
    renderHeader();
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
    renderMessages();
  }
  if (event.type === 'delta' && event.chatId === state.chat?.id) {
    let m = state.chat.messages.find((m) => m.id === event.itemId);
    if (!m) {
      m = { id: event.itemId, role: 'assistant', text: '', streaming: true };
      state.chat.messages.push(m);
    }
    m.text += event.delta;
    if (!state.renderTimer)
      state.renderTimer = setTimeout(() => {
        state.renderTimer = null;
        state.stick = nearBottom();
        renderMessages();
      }, 70);
  }
  if (event.type === 'status')
    $('connection-status').lastChild.textContent = event.message;
  if (event.type === 'outputs-changed' && event.chatId === state.chat?.id)
    attempt(refreshFiles);
  if (event.type === 'error') toast(event.message);
  if (event.type === 'question' && event.chatId === state.chat?.id) {
    if (
      !state.chat.pendingQuestions?.some((q) => q.requestId === event.requestId)
    ) {
      state.chat.pendingQuestions ||= [];
      state.chat.pendingQuestions.push(event);
    }
    renderQuestions();
  }
  if (
    event.type === 'draft' &&
    event.chatId === draftId() &&
    !state.draftTimers.has(draftId()) &&
    !state.sending
  ) {
    state.localDrafts.delete(draftId());
    $('prompt').value = event.draft.text || '';
    state.attachments = event.draft.attachments || [];
    renderAttachments();
  }
});
$('new-chat').onclick = () => attempt(newChat);
$('directory').onclick = () => attempt(chooseDirectory);
$('welcome-directory').onclick = () => attempt(chooseDirectory);
$('history-search').oninput = renderHistory;
$('attach').onclick = () =>
  attempt(async () => {
    const files = await api.selectFiles();
    await addFiles(files);
  });
$('send').onclick = () => attempt(send);
$('stop').onclick = () => attempt(() => api.stop(state.chat.id));
$('mention').onclick = () => {
  const n = $('prompt');
  n.value += (n.value && !/\s$/.test(n.value) ? ' ' : '') + '@';
  n.focus();
  attempt(mentions);
};
$('prompt').addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!$('mention-list').classList.contains('hidden')) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = state.mentions.length;
      if (!count) return;
      state.mentionIndex =
        (state.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) %
        count;
      [...$('mention-list').querySelectorAll('.mention-option')].forEach(
        (n, i) => n.classList.toggle('highlighted', i === state.mentionIndex),
      );
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention(state.mentionIndex);
      return;
    }
    if (event.key === 'Escape') {
      $('mention-list').classList.add('hidden');
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    attempt(send);
  }
});
$('prompt').oninput = () => {
  const n = $('prompt');
  n.style.height = 'auto';
  n.style.height = Math.min(n.scrollHeight, 190) + 'px';
  queueDraft();
  attempt(mentions);
};
$('prompt').addEventListener('paste', (event) => {
  const data = event.clipboardData;
  if (!data) return;
  const files = [...data.files];
  if (!files.length)
    for (const item of [...data.items]) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  if (files.length) {
    event.preventDefault();
    attempt(async () => {
      const images = [],
        paths = [];
      for (const f of files) {
        let filePath = '';
        try {
          filePath = api.filePath(f);
        } catch {}
        if (filePath) paths.push(filePath);
        else if (f.type.startsWith('image/')) images.push(f);
      }
      if (paths.length) await addFiles(paths);
      if (images.length) await addPastedImages(images);
      if (!paths.length && !images.length)
        toast('无法读取剪贴板文件，请直接拖入文件。');
    });
  } else if (![...data.types].includes('text/plain')) {
    event.preventDefault();
    attempt(pasteNativeImage);
  }
});
$('messages').onclick = (event) => {
  const a = event.target.closest('a');
  if (a) {
    event.preventDefault();
    attempt(() => api.open(a.getAttribute('href'), state.chat?.id));
  }
};
$('messages').onscroll = () => {
  state.stick = nearBottom();
  $('scroll-bottom').classList.toggle('hidden', state.stick);
};
$('scroll-bottom').onclick = () => {
  state.stick = true;
  bottom(true);
};
$('toggle-files').onclick = () => {
  $('files-panel').classList.toggle('hidden');
  $('toggle-files').classList.toggle('active');
};
$('outputs-tab').onclick = () => {
  state.filesMode = 'outputs';
  renderFiles();
};
$('all-files-tab').onclick = () => {
  state.filesMode = 'all';
  attempt(refreshFiles);
};
$('refresh-files').onclick = () => attempt(refreshFiles);
$('open-directory').onclick = () =>
  attempt(() =>
    state.chat
      ? api.open(state.chat.directory, state.chat.id)
      : chooseDirectory(),
  );
$('settings-open').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
$('history-mode').onchange = () =>
  attempt(async () => {
    await flushDraft();
    state.archived = $('history-mode').value === 'archived';
    state.chats = state.archived
      ? await api.listArchived()
      : await api.listChats();
    renderHistory();
  });
$('retry-close').onclick = () => $('retry-dialog').close();
$('retry-submit').onclick = () =>
  attempt(async () => {
    const id = state.retryId;
    $('retry-dialog').close();
    await api.retry(id, $('retry-profiles').value);
  });
$('help-open').onclick = () => $('help-dialog').showModal();
$('help-close').onclick = () => $('help-dialog').close();
$('help-diagnostics').onclick = () =>
  attempt(async () => {
    const p = await api.diagnostics();
    if (p) toast('诊断已导出');
  });
$('help-backup').onclick = () =>
  attempt(async () => {
    const p = await api.backupData();
    if (p) toast('备份已保存：' + p);
  });
$('help-restore').onclick = () =>
  attempt(async () => {
    const result = await api.importData('backup');
    if (result) {
      state.chats = await api.listChats();
      renderHistory();
      toast('已恢复 ' + result.conversations + ' 段对话');
    }
  });
$('help-import').onclick = () =>
  attempt(async () => {
    const result = await api.importData('directory');
    if (result) {
      state.chats = await api.listChats();
      renderHistory();
      toast('已导入 ' + result.conversations + ' 段对话');
    }
  });
$('onboarding-close').onclick = () =>
  attempt(async () => {
    await api.preferences({ onboarded: true });
    $('onboarding').close();
  });
$('onboarding-folder').onclick = () =>
  attempt(async () => {
    await chooseDirectory();
    if (state.chat) $('onboarding-location').textContent = state.chat.directory;
  });
$('onboarding-start').onclick = () =>
  attempt(async () => {
    if (!state.chat) {
      await chooseDirectory();
      if (!state.chat) return;
    }
    $('prompt').value = '请帮我整理添加的文件，提炼重点并生成一份摘要。';
    queueDraft();
    await api.preferences({ onboarded: true });
    $('onboarding').close();
    $('prompt').focus();
  });
$('task-template').onchange = () => {
  const prompts = {
    summary: '请阅读附件，提炼重点并生成一份 Word 摘要。',
    polish: '请润色附件文档，保留原意，优化结构与排版，生成新 Word 文件。',
    ocr: '请从图片或扫描 PDF 中提取文字，按页标注，生成可编辑文档；模糊内容标为待确认。',
    pdf: '请处理添加的 PDF。我要合并/拆分的规则是：',
    table: '请从附件提取关键信息，整理成 Excel 表格，保留来源。',
    research: '请联网检索以下主题，核对来源，并生成附真实来源链接的报告：',
  };
  if (prompts[$('task-template').value]) {
    $('prompt').value = prompts[$('task-template').value];
    queueDraft();
    $('prompt').focus();
  }
  $('task-template').value = '';
};
setInterval(() => {
  const task = state.chat?.tasks?.at(-1);
  if (state.chat?.busy && task) {
    $('activity-text').textContent =
      (state.chat.pendingQuestions?.length
        ? '等你回答'
        : state.chat.status || task.phase) +
      ' · 已用 ' +
      Math.floor((Date.now() - task.startedAt) / 1000) +
      ' 秒';
  }
}, 1000);
$('pet-open').onclick = () =>
  attempt(async () => {
    state.pet = await api.petStatus();
    const s = state.pet.settings;
    $('pet-enabled').checked = s.enabled;
    $('pet-notifications').checked = s.notifications;
    $('pet-quiet').checked = s.quiet;
    $('pet-topmost').checked = s.alwaysOnTop;
    $('pet-background').checked = s.closeToTray;
    const scale = $('pet-scale');
    if (![...scale.options].some((o) => Number(o.value) === s.scale)) {
      const option = el(
        'option',
        '',
        '自定义 ' + Math.round(s.scale * 100) + '%',
      );
      option.value = s.scale;
      scale.append(option);
    }
    scale.value = s.scale;
    $('pet-settings').showModal();
  });
$('pet-settings-close').onclick = () => $('pet-settings').close();
$('pet-preview').onclick = () => attempt(() => api.petQuick());
$('pet-form').onsubmit = (event) => {
  event.preventDefault();
  attempt(async () => {
    await api.configurePet({
      enabled: $('pet-enabled').checked,
      notifications: $('pet-notifications').checked,
      quiet: $('pet-quiet').checked,
      alwaysOnTop: $('pet-topmost').checked,
      closeToTray: $('pet-background').checked,
      scale: Number($('pet-scale').value),
    });
    $('pet-settings').close();
    toast('桌宠设置已保存');
  });
};
$('app-quit').onclick = () => attempt(() => api.quit());
$('benchmark-open').onclick = () => attempt(runBenchmark);
$('benchmark-rerun').onclick = () => attempt(runBenchmark);
$('benchmark-settings').onclick = () => {
  $('settings').close();
  attempt(runBenchmark);
};
$('benchmark-cancel').onclick = () => attempt(() => api.benchmarkCancel());
$('benchmark-close').onclick = () => $('benchmark-dialog').close();
$('setting-profile').onchange = () => editProfile($('setting-profile').value);
$('profile-new').onclick = () => {
  editProfile(null);
  $('setting-name').focus();
  $('setting-name').select();
};
$('profile-delete').onclick = () =>
  attempt(async () => {
    state.settings = await api.deleteProfile(state.editingProfileId);
    editProfile(state.settings.activeProfileId);
    renderHeader();
    toast('配置已删除');
  });
$('profile-switch').onchange = () =>
  attempt(async () => {
    try {
      state.settings = await api.selectProfile($('profile-switch').value);
      toast('已切换到 ' + state.settings.name);
    } finally {
      renderHeader();
    }
  });
$('model-label').onchange = () =>
  attempt(async () => {
    try {
      state.settings = await api.saveSettings({
        model: $('model-label').value,
      });
    } finally {
      renderHeader();
    }
  });
$('refresh-models').onclick = () =>
  attempt(async () => {
    $('refresh-models').disabled = true;
    $('settings-result').classList.remove('failure');
    $('settings-result').textContent = '正在读取此中转支持的模型…';
    try {
      const result = await api.profileModels(settingsValues());
      state.draftModels = result.models;
      const current = $('setting-model').value;
      modelOptions($('setting-model'), result.models, current);
      $('settings-result').textContent = result.models.length
        ? '已获取 ' + result.models.length + ' 个 GPT-6.1 / GPT-6 模型。'
        : '此中转未返回 GPT-6.1 / GPT-6 模型，已保留当前选项。';
    } catch (e) {
      $('settings-result').classList.add('failure');
      $('settings-result').textContent = e.message;
    } finally {
      $('refresh-models').disabled = false;
    }
  });
$('cli-check').onclick = () =>
  attempt(async () => {
    state.cli = await api.checkCli();
    renderCli();
  });
$('cli-update').onclick = () =>
  attempt(async () => {
    state.cli = await api.updateCli();
    renderCli();
    toast(state.cli.message);
  });
$('cli-rollback').onclick = () =>
  attempt(async () => {
    state.cli = await api.rollbackCli();
    renderCli();
    toast(state.cli.message);
  });
$('cli-cancel').onclick = () => attempt(() => api.cancelCliUpdate());
$('effort-label').onclick = openSettings;
$('fast-toggle').onclick = () =>
  attempt(async () => {
    state.settings = await api.saveSettings({
      fastMode: state.settings.fastMode === false,
    });
    renderHeader();
    toast('Fast 已' + (state.settings.fastMode ? '开启' : '关闭'));
  });
$('settings-form').onsubmit = (event) => {
  event.preventDefault();
  attempt(async () => {
    await saveSettings();
    $('settings').close();
    toast('设置已保存');
  });
};
$('test-connection').onclick = () =>
  attempt(async () => {
    $('test-connection').disabled = true;
    $('settings-result').classList.remove('failure');
    $('settings-result').textContent = '正在测试…';
    try {
      await saveSettings();
      const result = await api.testConnection();
      if (result.settings) state.settings = result.settings;
      state.draftModels = result.models;
      modelOptions($('setting-model'), result.models, state.settings.model);
      renderHeader();
      $('settings-result').textContent = result.modelFound
        ? '连接正常，当前模型可用。'
        : '连接正常；当前模型未列出，请从下拉菜单选择此中转支持的模型。';
    } catch (e) {
      $('settings-result').textContent = e.message;
      $('settings-result').classList.add('failure');
    } finally {
      $('test-connection').disabled = false;
    }
  });
$('export').onclick = () =>
  attempt(async () => {
    if (!state.chat) return;
    const p = await api.exportChat(state.chat.id);
    if (p) toast('对话已导出：' + p);
  });
$('rename-cancel').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = (event) => {
  event.preventDefault();
  attempt(async () => {
    const c = await api.renameChat(state.renameId, $('rename-title').value);
    if (c.id === state.chat?.id) state.chat = c;
    $('rename-dialog').close();
    state.chats = await api.listChats();
    renderHistory();
  });
};
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    attempt(newChat);
  }
  if (event.key === 'Escape') $('mention-list').classList.add('hidden');
});
document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if ([...event.dataTransfer.types].includes('Files')) {
    dropDepth++;
    $('drop-overlay').classList.remove('hidden');
  }
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dropDepth--;
  if (dropDepth <= 0) {
    dropDepth = 0;
    $('drop-overlay').classList.add('hidden');
  }
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dropDepth = 0;
  $('drop-overlay').classList.add('hidden');
  const paths = [...event.dataTransfer.files]
    .map((file) => api.filePath(file))
    .filter(Boolean);
  if (paths.length) attempt(() => addFiles(paths));
});
attempt(async () => {
  const initial = await api.initialize();
  Object.assign(state, {
    settings: initial.settings,
    chats: initial.chats,
    cli: initial.cli,
    benchmark: initial.benchmark,
    pet: initial.pet,
  });
  $('data-location').textContent = '本地数据：' + initial.dataDirectory;
  await restoreDraft('new');
  renderAll();
  if (!state.settings.hasApiKey) openSettings();
  else if (initial.onboarding) $('onboarding').showModal();
  const inherited = initial.inheritance;
  if (inherited?.newlyImported)
    toast(
      '已合并 ' +
        inherited.sourceCount +
        ' 个旧版目录，共 ' +
        inherited.conversations +
        ' 段对话，配置和截图也已继承。',
    );
  else if (inherited?.error) toast(inherited.error);
});
