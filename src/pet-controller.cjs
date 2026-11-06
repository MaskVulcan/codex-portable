'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { pathToFileURL } = require('node:url');
const { atomicJson, readJson } = require('./persistence.cjs');
const {
  normalizePetSettings,
  boundedPosition,
  companionState,
} = require('./pet-state.cjs');

class PetController {
  constructor({
    electron,
    root,
    assetsDirectory,
    getContext,
    onOpenChat,
    onQuickSend,
    onSelectDirectory,
    onSelectFiles,
    onDescribeFiles,
    onImportImage,
    onPasteImage,
    onStop,
    onOpenOutput,
    onQuit,
    onDraft,
    onAnswer,
    log = () => {},
  }) {
    Object.assign(this, {
      electron,
      root,
      assetsDirectory,
      getContext,
      onOpenChat,
      onQuickSend,
      onSelectDirectory,
      onSelectFiles,
      onDescribeFiles,
      onImportImage,
      onPasteImage,
      onStop,
      onOpenOutput,
      onQuit,
      onDraft,
      onAnswer,
      log,
    });
    this.settings = normalizePetSettings(
      readJson(path.join(root, 'pet.json'), {}),
    );
    this.window = null;
    this.quick = null;
    this.tray = null;
    this.notices = [];
    this.pendingFiles = [];
    this.closing = false;
    this.drag = null;
    this.timer = null;
    this.cursorTimer = null;
    this.announcements = new Set();
    this.locked = false;
  }
  supported() {
    return !!(this.electron.screen && this.electron.Tray && this.electron.Menu);
  }
  trusted(sender) {
    return (
      !!sender &&
      (sender === this.window?.webContents ||
        sender === this.quick?.webContents)
    );
  }
  status() {
    const context = this.getContext();
    return {
      ...companionState({
        ...context,
        notices: this.notices,
        quiet: this.settings.quiet,
      }),
      settings: { ...this.settings },
      notices: this.notices.map((n) => ({ ...n })),
      chats: context.chats.map((c) => ({
        id: c.id,
        title: c.title,
        busy: c.busy,
        status: c.status,
        directory: c.directory,
      })),
      active: context.active || null,
      profile: context.profile || {},
      renderer: this.renderer || 'loading',
      shortcut: this.shortcut !== false,
    };
  }
  send(target, channel, payload) {
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed())
      target.webContents.send(channel, payload);
  }
  broadcast() {
    const s = this.status();
    this.send(this.window, 'pet:event', { type: 'state', state: s });
    this.send(this.quick, 'pet:event', { type: 'state', state: s });
    return s;
  }
  schedule() {
    if (this.timer || this.closing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.broadcast();
    }, 100);
  }
  save() {
    try {
      atomicJson(path.join(this.root, 'pet.json'), this.settings);
    } catch (e) {
      this.log('Pet settings: ' + e.message);
    }
  }
  areas() {
    return this.electron.screen.getAllDisplays().map((d) => d.workArea);
  }
  bounds() {
    const scale = this.settings.scale,
      width = Math.round(310 * scale),
      height = Math.round(270 * scale),
      primary = this.electron.screen.getPrimaryDisplay().workArea;
    const position = this.settings.position || {
      x: primary.x + primary.width - width - 18,
      y: primary.y + primary.height - height - 18,
    };
    return boundedPosition({ ...position, width, height }, this.areas());
  }
  start() {
    if (!this.supported()) return;
    this.register();
    this.createTray();
    const shortcut = 'CommandOrControl+Alt+P';
    try {
      this.shortcut =
        this.electron.globalShortcut?.register(shortcut, () =>
          this.showQuick(),
        ) ?? false;
    } catch {
      this.shortcut = false;
    }
    this.electron.screen.on('display-removed', () => this.reposition());
    this.electron.screen.on('display-metrics-changed', () => this.reposition());
    this.electron.powerMonitor?.on('lock-screen', () => {
      this.locked = true;
      this.send(this.window, 'pet:event', { type: 'pause', paused: true });
    });
    this.electron.powerMonitor?.on('unlock-screen', () => {
      this.locked = false;
      this.send(this.window, 'pet:event', { type: 'pause', paused: false });
    });
    if (this.settings.enabled) this.show();
  }
  createTray() {
    // Linux CI/headless sessions have no native status area. Creating a GTK
    // tray there can terminate the process before JavaScript can catch it.
    if (
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    )
      return;
    const icon = this.electron.nativeImage
      .createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
      .resize({ width: 24, height: 24 });
    try {
      this.tray = new this.electron.Tray(icon);
      this.tray.setToolTip('Codex 文件助手 · Bongo');
      this.tray.on('double-click', () => this.onOpenChat(this.status().chatId));
      this.tray.on('click', () => this.showQuick());
      this.updateTray();
    } catch (e) {
      this.log('Tray unavailable: ' + e.message);
    }
  }
  updateTray() {
    if (!this.tray) return;
    this.tray.setContextMenu(
      this.electron.Menu.buildFromTemplate([
        {
          label: '打开文件助手',
          click: () => this.onOpenChat(this.status().chatId),
        },
        { label: '快捷聊天  Ctrl+Alt+P', click: () => this.showQuick() },
        { type: 'separator' },
        {
          label: this.settings.enabled ? '隐藏桌宠' : '显示桌宠',
          click: () => this.configure({ enabled: !this.settings.enabled }),
        },
        {
          label: '安静模式',
          type: 'checkbox',
          checked: this.settings.quiet,
          click: (item) => this.configure({ quiet: item.checked }),
        },
        {
          label: '任务完成提醒',
          type: 'checkbox',
          checked: this.settings.notifications,
          click: (item) => this.configure({ notifications: item.checked }),
        },
        {
          label: '打开输出文件夹',
          click: () => this.onOpenOutput(this.status().chatId),
        },
        { type: 'separator' },
        { label: '退出文件助手', click: () => this.onQuit() },
      ]),
    );
  }
  configure(update) {
    this.settings = normalizePetSettings({ ...this.settings, ...update });
    this.save();
    if (this.settings.enabled) this.show();
    else this.window?.hide();
    if (this.window && !this.window.isDestroyed()) {
      this.window.setAlwaysOnTop(this.settings.alwaysOnTop);
      this.window.setBounds(this.bounds());
      this.send(this.window, 'pet:event', {
        type: 'pause',
        paused: !this.settings.enabled,
      });
    }
    this.updateTray();
    this.broadcast();
    return this.settings;
  }
  show() {
    if (!this.supported()) return;
    if (!this.window || this.window.isDestroyed()) this.createPet();
    this.window.showInactive();
    this.send(this.window, 'pet:event', { type: 'pause', paused: false });
  }
  createPet() {
    this.window = new this.electron.BrowserWindow({
      ...this.bounds(),
      title: 'Bongo · Codex',
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: this.settings.alwaysOnTop,
      hasShadow: false,
      show: false,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'pet-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window.setMenu(null);
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (e) => e.preventDefault());
    this.window.loadFile(path.join(__dirname, 'pet', 'index.html'));
    this.window.webContents.on('did-finish-load', () => {
      this.broadcast();
      if (this.settings.enabled) this.window.showInactive();
    });
    this.window.on('close', (e) => {
      if (!this.closing) {
        e.preventDefault();
        this.configure({ enabled: false });
      }
    });
    this.window.on('hide', () =>
      this.send(this.window, 'pet:event', { type: 'pause', paused: true }),
    );
    this.cursorTimer = setInterval(() => {
      if (
        !this.window ||
        this.window.isDestroyed() ||
        !this.window.isVisible() ||
        this.locked
      )
        return;
      const cursor = this.electron.screen.getCursorScreenPoint(),
        bounds = this.window.getBounds();
      this.send(this.window, 'pet:event', {
        type: 'cursor',
        x: (cursor.x - bounds.x) / bounds.width,
        y: (cursor.y - bounds.y) / bounds.height,
      });
    }, 125);
  }
  reposition() {
    if (this.window && !this.window.isDestroyed()) {
      const b = this.window.getBounds();
      this.window.setBounds(boundedPosition(b, this.areas()));
      this.settings.position = {
        x: this.window.getBounds().x,
        y: this.window.getBounds().y,
      };
      this.save();
    }
    this.positionQuick();
  }
  positionQuick() {
    if (!this.quick || this.quick.isDestroyed()) return;
    const area = this.electron.screen.getPrimaryDisplay().workArea,
      pet =
        this.window && !this.window.isDestroyed()
          ? this.window.getBounds()
          : this.bounds();
    const width = Math.min(440, area.width - 24),
      height = Math.min(540, area.height - 24),
      display =
        this.areas().find((d) => pet.x >= d.x && pet.x < d.x + d.width) || area;
    const x =
      pet.x - width - 12 >= display.x
        ? pet.x - width - 12
        : pet.x + pet.width - width;
    this.quick.setBounds(
      boundedPosition(
        { x, y: pet.y + pet.height - height, width, height },
        this.areas(),
      ),
    );
  }
  showQuick() {
    if (!this.supported()) return;
    if (!this.quick || this.quick.isDestroyed()) {
      this.quick = new this.electron.BrowserWindow({
        width: 440,
        height: 540,
        minWidth: 350,
        minHeight: 360,
        title: 'Bongo 快捷聊天',
        frame: false,
        resizable: true,
        show: false,
        alwaysOnTop: this.settings.alwaysOnTop,
        skipTaskbar: true,
        backgroundColor: '#fcfbf8',
        webPreferences: {
          preload: path.join(__dirname, 'pet-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      this.quick.setMenu(null);
      this.quick.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.quick.webContents.on('will-navigate', (e) => e.preventDefault());
      this.quick.loadFile(path.join(__dirname, 'pet', 'quick.html'));
      this.quick.webContents.on('did-finish-load', () => {
        this.broadcast();
        this.send(this.quick, 'pet:event', { type: 'files-available' });
        this.quick.show();
        this.quick.focus();
      });
      this.quick.on('close', (e) => {
        if (!this.closing) {
          e.preventDefault();
          this.quick.hide();
        }
      });
    }
    this.positionQuick();
    this.broadcast();
    this.quick.show();
    this.quick.focus();
  }
  acknowledge(chatId) {
    this.notices = this.notices.filter((n) => n.chatId !== chatId);
    this.broadcast();
  }
  taskFinished(chat) {
    const failed = ['处理失败', '未能发送', '未能完成', '部分完成'].includes(
      chat.status,
    );
    if (chat.status === '已停止') return;
    const key = chat.id + ':' + chat.updatedAt;
    if (this.announcements.has(key)) return;
    this.announcements.add(key);
    if (this.announcements.size > 1000)
      this.announcements = new Set([...this.announcements].slice(-500));
    const result =
      chat.messages
        .filter((m) => m.role === 'assistant' || m.role === 'error')
        .at(-1)?.text || '';
    const count = chat.tasks?.at(-1)?.artifacts?.length || 0;
    const message = failed
      ? '任务遇到了问题，点我查看。'
      : count
        ? '已生成 ' + count + ' 个文件，点我查看。'
        : '已回复你的问题，点我查看。';
    const notice = {
      chatId: chat.id,
      title: chat.title,
      message,
      status: failed ? 'blocked' : 'ready',
      time: Date.now(),
      preview: result.slice(0, 180),
    };
    this.notices = [
      notice,
      ...this.notices.filter((n) => n.chatId !== chat.id),
    ].slice(0, 8);
    this.broadcast();
    this.send(this.window, 'pet:event', { type: 'notice', notice });
    const N = this.electron.Notification;
    if (
      !this.settings.quiet &&
      this.settings.notifications &&
      N?.isSupported?.()
    ) {
      try {
        const toast = new N({
          title: failed ? 'Codex · 任务遇到问题' : 'Codex · 处理完成',
          body: chat.title + '：' + message,
          silent: true,
        });
        toast.on('click', () => {
          this.acknowledge(chat.id);
          this.onOpenChat(chat.id);
        });
        toast.show();
      } catch (e) {
        this.log('Task notification: ' + e.message);
      }
    }
  }
  menu() {
    this.electron.Menu.buildFromTemplate([
      {
        label: '摸摸猫头',
        click: () =>
          this.send(this.window, 'pet:event', {
            type: 'interact',
            kind: 'pat',
          }),
      },
      {
        label: '逗猫 / 敲一下',
        click: () =>
          this.send(this.window, 'pet:event', {
            type: 'interact',
            kind: 'tap',
          }),
      },
      { label: '快捷聊天', click: () => this.showQuick() },
      {
        label: '打开当前对话',
        click: () => {
          this.acknowledge(this.status().chatId);
          this.onOpenChat(this.status().chatId);
        },
      },
      {
        label: '打开输出文件夹',
        click: () => this.onOpenOutput(this.status().chatId),
      },
      { type: 'separator' },
      {
        label: '放大一点',
        click: () => this.configure({ scale: this.settings.scale + 0.1 }),
      },
      {
        label: '缩小一点',
        click: () => this.configure({ scale: this.settings.scale - 0.1 }),
      },
      {
        label: '安静模式',
        type: 'checkbox',
        checked: this.settings.quiet,
        click: (item) => this.configure({ quiet: item.checked }),
      },
      { label: '隐藏桌宠', click: () => this.configure({ enabled: false }) },
      { label: '退出', click: () => this.onQuit() },
    ]).popup({ window: this.window });
  }
  register() {
    const handle = (name, fn) =>
      this.electron.ipcMain.handle('pet:' + name, async (e, ...args) => {
        if (!this.trusted(e.sender)) throw new Error('无效的桌宠窗口请求。');
        try {
          return await fn(...args);
        } catch (error) {
          this.log('pet ' + name + ': ' + error.message);
          throw error;
        }
      });
    handle('init', () => ({
      state: this.status(),
      modelUrl: 'petassets://local/bongo/cat.model3.json',
    }));
    handle('state', () => this.status());
    handle('quick', () => this.showQuick());
    handle('hide-quick', () => this.quick?.hide());
    handle('menu', () => this.menu());
    handle('renderer', (mode) => {
      this.renderer = mode === 'live2d' ? 'live2d' : 'fallback';
      this.broadcast();
    });
    handle('open-chat', (id) => {
      const chatId = id || this.status().chatId;
      this.acknowledge(chatId);
      this.onOpenChat(chatId);
    });
    handle('open-output', (id) =>
      this.onOpenOutput(id || this.status().chatId),
    );
    handle('send', async (text, files) => {
      const result = await this.onQuickSend(text, files);
      this.broadcast();
      return result;
    });
    handle('draft', (id, value) => this.onDraft(id, value));
    handle('answer', (id, answers) => this.onAnswer(id, answers));
    handle('attach-drop', async (files) => {
      const described = await this.onDescribeFiles(files);
      this.pendingFiles.push(...described);
      this.showQuick();
      this.send(this.quick, 'pet:event', { type: 'files-available' });
      return true;
    });
    handle('take-files', () => {
      const files = this.pendingFiles;
      this.pendingFiles = [];
      return files;
    });
    handle('stop', (id) => this.onStop(id));
    handle('select-directory', () => this.onSelectDirectory());
    handle('select-files', () => this.onSelectFiles());
    handle('describe-files', (files) => this.onDescribeFiles(files));
    handle('import-image', (bytes, name) => this.onImportImage(bytes, name));
    handle('paste-image', () => this.onPasteImage());
    handle('hit', (interactive) => {
      if (this.window && !this.window.isDestroyed() && !this.drag)
        this.window.setIgnoreMouseEvents(!interactive, { forward: true });
    });
    handle('drag', (stage) => {
      if (!this.window) return;
      const cursor = this.electron.screen.getCursorScreenPoint();
      if (stage === 'start') {
        this.window.setIgnoreMouseEvents(false);
        this.drag = { cursor, bounds: this.window.getBounds() };
      } else if (this.drag) {
        const b = this.drag.bounds;
        this.window.setPosition(
          Math.round(b.x + cursor.x - this.drag.cursor.x),
          Math.round(b.y + cursor.y - this.drag.cursor.y),
        );
        if (stage === 'end') {
          this.drag = null;
          this.reposition();
        }
      }
    });
    handle('configure', (update) => this.configure(update));
    handle('interact', (kind) => {
      if (['pat', 'tap'].includes(kind))
        this.send(this.window, 'pet:event', { type: 'interact', kind });
    });
  }
  registerAssets() {
    const protocol = this.electron.protocol;
    if (!protocol?.handle) return;
    protocol.handle('petassets', async (request) => {
      try {
        const u = new URL(request.url);
        if (u.hostname !== 'local')
          return new Response('Not found', { status: 404 });
        const relative = decodeURIComponent(u.pathname).replace(/^\//, ''),
          file = path.resolve(this.assetsDirectory, relative),
          base = path.resolve(this.assetsDirectory) + path.sep;
        if (
          !file.startsWith(base) ||
          relative.includes('\\') ||
          !fs.existsSync(file)
        )
          return new Response('Not found', { status: 404 });
        return this.electron.net.fetch(pathToFileURL(file).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }
  shutdown() {
    this.closing = true;
    clearTimeout(this.timer);
    clearInterval(this.cursorTimer);
    try {
      this.electron.globalShortcut?.unregister('CommandOrControl+Alt+P');
    } catch {}
    this.quick?.destroy();
    this.window?.destroy();
    this.tray?.destroy();
  }
}
module.exports = { PetController };
