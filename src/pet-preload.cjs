'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke('pet:' + name, ...args);
contextBridge.exposeInMainWorld('companion', {
  init: () => invoke('init'),
  state: () => invoke('state'),
  quick: () => invoke('quick'),
  hideQuick: () => invoke('hide-quick'),
  menu: () => invoke('menu'),
  renderer: (mode) => invoke('renderer', mode),
  openChat: (id) => invoke('open-chat', id),
  openOutput: (id) => invoke('open-output', id),
  send: (text, files) => invoke('send', text, files),
  stop: (id) => invoke('stop', id),
  selectDirectory: () => invoke('select-directory'),
  selectFiles: () => invoke('select-files'),
  describeFiles: (files) => invoke('describe-files', files),
  importImage: (bytes, name) => invoke('import-image', bytes, name),
  pasteImage: () => invoke('paste-image'),
  filePath: (file) => webUtils.getPathForFile(file),
  hit: (active) => invoke('hit', active),
  drag: (stage) => invoke('drag', stage),
  configure: (update) => invoke('configure', update),
  onEvent: (callback) => {
    const fn = (_, event) => callback(event);
    ipcRenderer.on('pet:event', fn);
    return () => ipcRenderer.removeListener('pet:event', fn);
  },
  attachDrop: (files) => invoke('attach-drop', files),
  takeFiles: () => invoke('take-files'),
  interact: (kind) => invoke('interact', kind),
  draft: (id, value) => invoke('draft', id, value),
  answer: (id, answers) => invoke('answer', id, answers),
});
