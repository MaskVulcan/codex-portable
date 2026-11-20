'use strict';
const $ = (id) => document.getElementById(id);
async function show() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  $('status').textContent = status.connected
    ? '已连接本机助手'
    : status.error || '未连接';
}
$('connect').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'connect',
      url: $('pair').value.trim(),
      tabId: tab?.id,
    });
    $('status').textContent = result.error || '正在连接…';
    $('pair').value = '';
    setTimeout(show, 800);
  } catch (e) {
    $('status').textContent = e.message;
  }
};
$('disconnect').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  await show();
};
show();
