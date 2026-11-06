'use strict';
function inheritedInputItems(chat) {
  // The last user message is the pending request and is sent by turn/start.
  // Rehydrate visible history only if native history is missing or this is a
  // preserved divergent branch. Native rollouts remain the preferred source.
  const messages = chat.messages.slice(0, -1),
    items = [];
  for (const m of messages) {
    if (!['user', 'assistant'].includes(m.role)) continue;
    let text = m.text || '';
    if (m.attachments?.length)
      text +=
        '\n\n本地附件：\n' +
        m.attachments
          .map((a) => '- ' + (a.name || '文件') + ': ' + a.path)
          .join('\n');
    if (!text.trim()) continue;
    items.push({
      type: 'message',
      role: m.role,
      content: [
        { type: m.role === 'user' ? 'input_text' : 'output_text', text },
      ],
    });
  }
  return items;
}
module.exports = { inheritedInputItems };
