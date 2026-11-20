'use strict';
const api = window.companion,
  $ = (id) => document.getElementById(id);
let current = null,
  files = [],
  sending = false,
  imports = 0,
  depth = 0,
  view = 'chat',
  lastTap = 0,
  draftTimer = null,
  displayedId = null;
function saveDraft() {
  if (!current?.active) return;
  clearTimeout(draftTimer);
  const id = current.active.id,
    value = { text: $('prompt').value, attachments: structuredClone(files) };
  draftTimer = setTimeout(() => {
    draftTimer = null;
    run(() => api.draft(id, value));
  }, 200);
}
function element(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function error(message) {
  $('error').textContent = String(message || '');
  $('error').classList.toggle('hidden', !message);
}
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    error(e.message);
    return null;
  }
}
function basename(p) {
  return p?.split(/[\\/]/).filter(Boolean).pop() || '选择工作文件夹';
}
function render() {
  if (!current) return;
  const chat = current.active,
    busy = !!chat?.busy;
  if (displayedId !== chat?.id) {
    displayedId = chat?.id;
    files = chat?.draft?.attachments || [];
    $('prompt').value = chat?.draft?.text || '';
    renderFiles();
    error('');
  } else if (
    !sending &&
    !draftTimer &&
    document.activeElement !== $('prompt') &&
    chat?.draft
  ) {
    files = chat.draft.attachments || [];
    $('prompt').value = chat.draft.text || '';
    renderFiles();
  }
  $('folder-label').textContent = basename(chat?.directory);
  $('folder').title = chat?.directory || '选择工作目录';
  $('profile').textContent =
    (current.profile.name || '') + ' · ' + (current.profile.model || '');
  $('status-text').textContent = imports
    ? '正在添加图片…'
    : chat?.status || current.message;
  if (!imports && chat?.task?.collection) {
    const c = chat.task.collection;
    $('status-text').textContent =
      `${chat.status} · ${c.completed}/${c.total} 篇 · ${c.screenshots} 张截图`;
  }
  $('badge').textContent = current.noticeCount || '';
  $('send').disabled = busy || sending || imports > 0;
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
  $('prompt').disabled = busy || sending;
  $('folder').disabled = busy || sending;
  $('attach').disabled = busy || sending;
  const host = $('messages'),
    atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 75;
  host.replaceChildren();
  if (chat?.messages.length) {
    for (const m of chat.messages) {
      const item = element('div', 'message ' + m.role, m.text || '');
      if (m.attachments?.length)
        item.append(
          element(
            'small',
            '',
            m.attachments.map((f) => '▤ ' + f.name).join('\n'),
          ),
        );
      host.append(item);
    }
    if (atBottom) host.scrollTop = host.scrollHeight;
  } else
    host.append(
      element('div', 'empty', '这是新的对话。给我文件或说说你想做什么。'),
    );
  const questions = $('questions');
  questions.replaceChildren();
  const pending = chat?.pendingQuestions?.[0];
  questions.classList.toggle('hidden', !pending);
  if (pending) {
    for (const q of pending.questions) {
      questions.append(element('p', '', q.question));
      const input = element('input');
      input.dataset.id = q.id;
      input.placeholder = '输入回答';
      if (q.isSecret) input.type = 'password';
      for (const o of q.options || []) {
        const b = element('button', '', o.label);
        b.onclick = () => (input.value = o.label);
        questions.append(b);
      }
      questions.append(input);
    }
    const button = element('button', '', '继续处理');
    button.onclick = () =>
      run(async () => {
        const answers = {};
        for (const input of questions.querySelectorAll('input')) {
          if (!input.value.trim()) throw new Error('请回答每个问题。');
          answers[input.dataset.id] = { answers: [input.value] };
        }
        await api.answer(pending.requestId, answers);
      });
    questions.append(button);
  }
  const tasks = $('activities');
  tasks.replaceChildren();
  const live = current.chats
    .filter((c) => c.busy)
    .map((c) => ({
      chatId: c.id,
      title: c.title,
      message: c.status || '正在处理',
      status: 'running',
    }));
  for (const item of [...live, ...current.notices]) {
    const row = element('div', 'task');
    row.append(
      element(
        'strong',
        '',
        (item.status === 'ready'
          ? '✓ '
          : item.status === 'blocked'
            ? '! '
            : '◦ ') + item.title,
      ),
      element('p', '', item.message),
    );
    const buttons = element('div');
    const open = element('button', '', '打开对话');
    open.onclick = () => run(() => api.openChat(item.chatId));
    buttons.append(open);
    if (item.status === 'ready') {
      const output = element('button', '', '打开结果');
      output.onclick = () => run(() => api.openOutput(item.chatId));
      buttons.append(output);
    }
    row.append(buttons);
    tasks.append(row);
  }
  if (!tasks.childElementCount)
    tasks.append(element('div', 'empty', '任务完成后，我会在这里提醒你。'));
}
function renderFiles() {
  const host = $('attachments');
  host.replaceChildren();
  files.forEach((file, i) => {
    const chip = element('div', 'chip');
    if (/^data:image\/png;base64,[\w+/=]+$/.test(file.thumbnail || '')) {
      const img = element('img');
      img.src = file.thumbnail;
      img.alt = file.name;
      chip.append(img);
    }
    chip.append(element('span', '', file.name));
    const remove = element('button', '', '×');
    remove.onclick = () => {
      files.splice(i, 1);
      renderFiles();
      saveDraft();
    };
    chip.append(remove);
    host.append(chip);
  });
}
function add(described) {
  for (const f of described || [])
    if (!files.some((x) => x.path === f.path)) files.push(f);
  renderFiles();
  saveDraft();
  $('prompt').focus();
}
async function takeFiles() {
  add(await api.takeFiles());
}
async function send() {
  const text = $('prompt').value.trim();
  if ((!text && !files.length) || sending || imports) return;
  error('');
  sending = true;
  render();
  const id = current?.active?.id;
  try {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (id) await api.draft(id, { text, attachments: files });
    const result = await api.send(
      text,
      files.map((f) => f.path),
    );
    if (result?.accepted) {
      if (!id || current?.active?.id === id) {
        $('prompt').value = '';
        files = [];
        renderFiles();
      }
      if (id) await api.draft(id, { text: '', attachments: [] });
    }
    current = await api.state();
  } finally {
    sending = false;
    render();
  }
}
api.onEvent((event) => {
  if (event.type === 'state') {
    current = event.state;
    render();
  }
  if (event.type === 'files-available') run(takeFiles);
});
$('close').onclick = () => run(() => api.hideQuick());
$('full').onclick = () => run(() => api.openChat(current?.active?.id));
$('output').onclick = () => run(() => api.openOutput(current?.active?.id));
$('folder').onclick = () =>
  run(async () => {
    if (await api.selectDirectory()) {
      current = await api.state();
      render();
    }
  });
$('attach').onclick = () => run(async () => add(await api.selectFiles()));
$('send').onclick = () => run(send);
$('stop').onclick = () => run(() => api.stop(current?.active?.id));
$('prompt').addEventListener('keydown', (event) => {
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    run(send);
  }
});
$('prompt').addEventListener('input', () => {
  saveDraft();
  const n = $('prompt');
  n.style.height = 'auto';
  n.style.height = Math.min(n.scrollHeight, 120) + 'px';
  if (Date.now() - lastTap > 250) {
    lastTap = Date.now();
    run(() => api.interact('tap'));
  }
});
$('prompt').addEventListener('paste', (event) => {
  const data = event.clipboardData;
  if (!data) return;
  const list = [...data.files];
  if (list.length) {
    event.preventDefault();
    run(async () => {
      imports++;
      render();
      try {
        for (const f of list) {
          let p = '';
          try {
            p = api.filePath(f);
          } catch {}
          if (p) add(await api.describeFiles([p]));
          else if (f.type.startsWith('image/')) {
            if (f.size > 32 * 1024 * 1024)
              throw new Error('图片不能超过 32 MB。');
            add([
              await api.importImage(
                new Uint8Array(await f.arrayBuffer()),
                f.name,
              ),
            ]);
          }
        }
      } finally {
        imports--;
        render();
      }
    });
  } else if (![...data.types].includes('text/plain')) {
    event.preventDefault();
    run(async () => {
      const f = await api.pasteImage();
      if (f) add([f]);
    });
  }
});
function tab(name) {
  view = name;
  $('messages').classList.toggle('hidden', name !== 'chat');
  $('activities').classList.toggle('hidden', name !== 'activity');
  $('chat-tab').classList.toggle('selected', name === 'chat');
  $('activity-tab').classList.toggle('selected', name === 'activity');
}
$('chat-tab').onclick = () => tab('chat');
$('activity-tab').onclick = () => tab('activity');
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if ([...e.dataTransfer.types].includes('Files')) {
    depth++;
    $('drop').classList.remove('hidden');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--depth <= 0) {
    depth = 0;
    $('drop').classList.add('hidden');
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  $('drop').classList.add('hidden');
  const paths = [...e.dataTransfer.files]
    .map((f) => api.filePath(f))
    .filter(Boolean);
  run(async () => add(await api.describeFiles(paths)));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') run(() => api.hideQuick());
});
run(async () => {
  const initial = await api.init();
  current = initial.state;
  render();
  await takeFiles();
  $('prompt').focus();
});
