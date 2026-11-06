'use strict';
const DEFAULT_PET_SETTINGS = {
  enabled: true,
  scale: 1,
  alwaysOnTop: true,
  notifications: true,
  quiet: false,
  closeToTray: true,
  position: null,
};
function normalizePetSettings(input = {}) {
  const result = { ...DEFAULT_PET_SETTINGS };
  for (const key of [
    'enabled',
    'alwaysOnTop',
    'notifications',
    'quiet',
    'closeToTray',
  ])
    if (typeof input[key] === 'boolean') result[key] = input[key];
  if (typeof input.scale === 'number' && Number.isFinite(input.scale))
    result.scale = Math.max(0.7, Math.min(1.4, input.scale));
  if (
    input.position &&
    Number.isFinite(input.position.x) &&
    Number.isFinite(input.position.y)
  )
    result.position = {
      x: Math.round(input.position.x),
      y: Math.round(input.position.y),
    };
  return result;
}
function boundedPosition(bounds, displays) {
  const work = displays.find(
    (d) =>
      bounds.x + bounds.width / 2 >= d.x &&
      bounds.x + bounds.width / 2 < d.x + d.width &&
      bounds.y + bounds.height / 2 >= d.y &&
      bounds.y + bounds.height / 2 < d.y + d.height,
  ) ||
    displays[0] || { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    ...bounds,
    x: Math.round(
      Math.max(work.x, Math.min(bounds.x, work.x + work.width - bounds.width)),
    ),
    y: Math.round(
      Math.max(
        work.y,
        Math.min(bounds.y, work.y + work.height - bounds.height),
      ),
    ),
  };
}
function companionState({
  chats = [],
  questions = [],
  notices = [],
  activeChatId = null,
  quiet = false,
  maintenance = false,
}) {
  const pending = new Set(questions),
    active = chats.find((c) => c.id === activeChatId),
    busy = chats.filter((c) => c.busy);
  const needs = chats.find((c) => pending.has(c.id));
  const failed = notices.find((n) => n.status === 'blocked'),
    ready = notices.find((n) => n.status === 'ready');
  let state = 'idle',
    message = '我在这里，随时开工。',
    target = active;
  if (needs) {
    state = 'needsInput';
    message = '有个问题需要你回答。';
    target = needs;
  } else if (failed) {
    state = 'blocked';
    message = failed.message || '任务遇到了问题，点我查看。';
    target = chats.find((c) => c.id === failed.chatId) || active;
  } else if (ready) {
    state = 'ready';
    message = ready.message || '处理好了，结果已经保存。';
    target = chats.find((c) => c.id === ready.chatId) || active;
  } else if (busy.length) {
    target = busy.find((c) => c.id === activeChatId) || busy[0];
    state =
      target.activity?.at(-1)?.type === 'commandExecution' ||
      /处理文件|保存文件|使用工具/.test(target.status || '')
        ? 'working'
        : 'thinking';
    message = target.status || '正在认真处理…';
  } else if (maintenance) {
    state = 'working';
    message = '正在测速或更新，请稍候。';
  }
  return {
    state,
    message,
    chatId: target?.id || null,
    title: target?.title || '新对话',
    directory: active?.directory || target?.directory || '',
    activeChatId,
    busyCount: busy.length,
    noticeCount: notices.length,
    quiet,
  };
}
module.exports = {
  DEFAULT_PET_SETTINGS,
  normalizePetSettings,
  boundedPosition,
  companionState,
};
