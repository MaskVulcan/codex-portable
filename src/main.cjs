'use strict';
const electron = require('electron');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  net,
  clipboard,
  nativeImage,
} = electron;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const {
  Store,
  CodexRpc,
  readJson,
  redact,
  instructions,
  scanFiles,
  modelCatalog,
} = require('./core.cjs');
const { CliUpdater } = require('./updater.cjs');
const {
  MAX_IMAGE_BYTES,
  imageThumbnail,
  storeImage,
  clipboardImage,
} = require('./attachments.cjs');
const { resolveRuntime, configurePythonOverlay } = require('./runtime.cjs');
const { RelayBenchmark } = require('./benchmark.cjs');
const { PetController } = require('./pet-controller.cjs');
const { Inheritor } = require('./inheritance.cjs');
const { inheritedInputItems } = require('./conversation-history.cjs');
const {
  WorkspaceState,
  abortable,
  cancelled,
  failure,
  snapshotInputs,
  validateOutputs,
  taskOutcome,
  newTask,
} = require('./workflow.cjs');
const { zipFiles, backupData, extractBackup } = require('./data-tools.cjs');
const { BrowserBridge } = require('./browser-bridge.cjs');
const { BrowserCollector } = require('./browser-collection.cjs');
const { updateProgress } = require('./progress.cjs');
electron.protocol?.registerSchemesAsPrivileged([
  {
    scheme: 'petassets',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const appDirectory =
  process.env.PORTABLE_APP_DIR ||
  (app.isPackaged
    ? path.dirname(process.execPath)
    : path.join(__dirname, '..'));
const root = process.env.PORTABLE_DATA_DIR || path.join(appDirectory, 'data');
try {
  fs.mkdirSync(root, { recursive: true });
  fs.accessSync(root, fs.constants.W_OK);
} catch (e) {
  dialog.showErrorBox(
    '无法写入数据目录',
    '请把程序放到你可以写入的文件夹中，例如桌面或 D 盘。\n' + e.message,
  );
  app.exit(1);
}
app.setPath('userData', path.join(root, 'browser'));
app.setPath('sessionData', path.join(root, 'browser'));
app.setPath('logs', path.join(root, 'logs'));
// Acquire the shared data-directory lock before reading or writing settings.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,MediaSessionService',
);
if (process.env.PORTABLE_DISABLE_GPU === '1') app.disableHardwareAcceleration();
let inheritanceWindow = null,
  inheritanceProgress = '正在查找旧版对话…';
const inheritor = new Inheritor({
  appDirectory,
  root,
  version: app.getVersion(),
  onProgress: (message) => {
    inheritanceProgress = message;
    if (
      inheritanceWindow &&
      !inheritanceWindow.isDestroyed() &&
      !inheritanceWindow.webContents.isLoading()
    )
      inheritanceWindow.webContents
        .executeJavaScript(
          'document.getElementById("progress").textContent=' +
            JSON.stringify(message),
        )
        .catch(() => {});
  },
});
const inheritanceInspection = inheritor.inspect();
function launchApplication(inheritanceInfo) {
  const payload =
    process.env.PORTABLE_PAYLOAD_DIR ||
    (app.isPackaged
      ? path.join(appDirectory, 'config')
      : path.join(__dirname, '..', 'payload'));
  const preset = readJson(path.join(payload, 'provisioning.json'), {
    baseUrl: 'https://api.aixhan.com/v1',
    apiKey: '',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'xhigh',
    fastMode: true,
    webSearch: true,
  });
  let store;
  try {
    store = new Store(root, preset);
  } catch (error) {
    dialog.showErrorBox(
      '无法保存本地配置',
      '未能写入程序旁的 data 文件夹。请关闭程序后重试，或把整个文件夹移到桌面等可写位置。现有数据不会被删除。\n' +
        redact(error.message, [
          preset.apiKey,
          ...(preset.profiles || []).map((p) => p.apiKey),
        ]),
    );
    app.exit(1);
    process.exit(1);
  }
  let window = null,
    rpc = null,
    starting = null,
    runtime = null,
    quitting = false,
    maintenance = false,
    currentChatId = null,
    backendEpoch = 0;
  const workspace = new WorkspaceState(root),
    operations = new Map();
  const resumed = new Set(),
    byThread = new Map(),
    flushTimers = new Map(),
    progressTimers = new Map(),
    questions = new Map();
  const actions = new Map();
  const browser = new BrowserBridge({
    root,
    onCall: browserCall,
    onChange: (status) => event('browser-status', { status }),
  });
  const collector = new BrowserCollector({
    bridge: browser,
    onProgress: (task, detail) => {
      const chat = [...store.chats.values()].find(
        (c) => c.tasks?.at(-1)?.id === task.id,
      );
      if (!chat) return;
      task.progress ||= {};
      task.progress.updatedAt = Date.now();
      task.progress.detail = detail;
      if (chat.busy)
        chat.status =
          task.collection?.status === 'needs_user'
            ? '需要登录或验证'
            : '正在采集浏览器内容';
      save(chat);
      publish(chat);
    },
  });
  function browserOperation(taskId) {
    for (const [id, op] of operations)
      if (op.task?.id === taskId && !op.controller.signal.aborted)
        return { chat: store.get(id), operation: op, task: op.task };
    throw new Error('浏览器任务已停止或过期，请在当前对话重新发送。');
  }
  async function browserCall(args) {
    const { chat, operation, task } = browserOperation(args.taskId),
      signal = operation.controller.signal;
    task.progress ||= {};
    task.progress.updatedAt = Date.now();
    const names = {
      browser_open: '打开网页',
      browser_read: '读取页面',
      browser_action: '操作页面',
      browser_screenshot: '保存截图',
      browser_collect: '批量采集',
    };
    task.progress.detail = names[args.tool] || '浏览器操作';
    publish(chat);
    if (args.tool === 'browser_collect')
      return collector.collect({
        task,
        session: chat.id,
        urls: args.urls,
        commentPages: args.commentPages ?? 5,
        signal,
      });
    if (args.tool === 'browser_screenshot') {
      const file = await collector.screenshot(
        chat.id,
        path.join(task.output, '浏览器截图'),
        '截图-' + Date.now(),
        signal,
      );
      return { path: file };
    }
    const op = {
      browser_open: 'open',
      browser_read: 'read',
      browser_action: args.action,
    }[args.tool];
    if (!['open', 'read', 'click', 'fill', 'scroll'].includes(op))
      throw new Error('不支持的浏览器工具。');
    const result = await browser.request(chat.id, op, args, signal);
    task.progress.updatedAt = Date.now();
    task.progress.currentUrl = result?.url;
    if (result?.gate) {
      chat.status = '需要登录或验证';
      task.progress.detail = '请打开浏览器，在网页完成登录或验证。';
    }
    save(chat);
    publish(chat);
    return result;
  }
  const petAssets = fs.existsSync(
    path.join(appDirectory, 'pets', 'bongo', 'cat.model3.json'),
  )
    ? path.join(appDirectory, 'pets')
    : path.join(__dirname, '..', 'pet-assets');
  const pet = new PetController({
    electron,
    root,
    assetsDirectory: petAssets,
    getContext: petContext,
    onOpenChat: showConversation,
    onQuickSend: quickSend,
    onSelectDirectory: selectQuickDirectory,
    onSelectFiles: () => actions.get('select-files')(),
    onDescribeFiles: describeFiles,
    onImportImage: (bytes, name) => storeImage(root, bytes, nativeImage, name),
    onPasteImage: () => clipboardImage(root, clipboard, nativeImage),
    onStop: (id) => actions.get('stop')(id),
    onOpenOutput: openChatOutput,
    onQuit: requestQuit,
    onDraft: (id, value) =>
      actions.get(value ? 'save-draft' : 'get-draft')(id, value),
    onAnswer: (id, answers) => answerQuestion(id, answers),
    log,
  });
  const bundledCodex = path.join(appDirectory, 'codex');
  const updater = new CliUpdater({
    root,
    payload,
    bundledDirectory: fs.existsSync(path.join(bundledCodex, 'bin', 'codex.exe'))
      ? bundledCodex
      : undefined,
    getSettings: () => ({ ...store.settings }),
    transport: net ? (url, options) => net.fetch(url, options) : undefined,
    beforeSwitch: stopBackend,
    afterSwitch: async () => {
      runtime = null;
      await backend(true);
    },
    onProgress: (status) => event('cli-update', { status }),
  });
  const benchmark = new RelayBenchmark({
    getProfiles: () => store.settings.profiles,
    getParameters: () => ({
      model: store.settings.model,
      reasoningEffort: store.settings.reasoningEffort,
      fastMode: store.settings.fastMode,
    }),
    transport: net ? (url, options) => net.fetch(url, options) : fetch,
    onChange: (status) => event('benchmark', { status }),
  });
  function event(type, data = {}) {
    if (window && !window.isDestroyed())
      window.webContents.send('portable:event', { type, ...data });
    pet.schedule();
  }
  function petContext() {
    const chats = [...store.chats.values()],
      active = chats.find((c) => c.id === currentChatId) || chats[0];
    return {
      chats,
      activeChatId: active?.id || null,
      active: active
        ? {
            id: active.id,
            title: active.title,
            directory: active.directory,
            busy: active.busy,
            status: active.status,
            pendingQuestions: active.pendingQuestions || [],
            draft: workspace.draft(active.id),
            task: active.tasks?.at(-1),
            messages: active.messages
              .filter(
                (m) =>
                  m.role === 'user' ||
                  m.role === 'assistant' ||
                  m.role === 'error',
              )
              .slice(-8)
              .map((m) => ({
                role: m.role,
                text: m.text,
                attachments: m.attachments || [],
              })),
          }
        : null,
      questions: chats
        .filter((c) => c.pendingQuestions?.length)
        .map((c) => c.id),
      maintenance: maintenance || updater.busy || benchmark.status().busy,
      profile: { name: store.settings.name, model: store.settings.model },
    };
  }
  function showConversation(id) {
    if (!window || window.isDestroyed()) return;
    if (id) {
      currentChatId = id;
      pet.acknowledge(id);
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    event('open-chat', { chatId: id || currentChatId });
  }
  async function selectQuickDirectory() {
    const result = await dialog.showOpenDialog(pet.quick || window, {
      title: '选择快捷聊天的工作目录',
      defaultPath: store.settings.lastDirectory || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    const chat = actions.get('create-chat')(result.filePaths[0]);
    currentChatId = chat.id;
    pet.schedule();
    return chat.directory;
  }
  async function quickSend(text, files) {
    let chat = currentChatId ? store.get(currentChatId) : null;
    if (!chat) {
      const directory = store.settings.lastDirectory;
      if (directory && fs.existsSync(directory))
        chat = actions.get('create-chat')(directory);
      else {
        if (!(await selectQuickDirectory())) return { accepted: false };
        chat = store.get(currentChatId);
      }
    }
    currentChatId = chat.id;
    pet.acknowledge(chat.id);
    return actions.get('send')(chat.id, text, files || []);
  }
  async function openChatOutput(id) {
    const chat = id
      ? store.get(id)
      : currentChatId
        ? store.get(currentChatId)
        : null;
    if (!chat) {
      showConversation();
      return;
    }
    const output =
      chat.tasks?.at(-1)?.output || path.join(chat.directory, '输出');
    fs.mkdirSync(output, { recursive: true });
    const error = await shell.openPath(output);
    if (error) throw new Error(error);
  }
  function requestQuit() {
    if (store.list().some((c) => c.busy)) {
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: '退出文件助手',
        message: '退出将停止正在执行的任务。',
        buttons: ['继续执行', '停止并退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice !== 1) return;
    }
    quitting = true;
    app.quit();
  }
  function log(message) {
    try {
      const dir = path.join(root, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'app.log');
      if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024)
        fs.renameSync(f, f + '.old');
      fs.appendFileSync(
        f,
        new Date().toISOString() +
          ' ' +
          redact(message, store.secrets()) +
          '\n',
      );
    } catch {}
  }
  function saveError(error) {
    log('save: ' + error.message);
    event('error', {
      message:
        '本地保存暂时失败，内容仍在当前窗口中。请稍后重试，暂时不要删除 data 文件夹。',
    });
  }
  function save(chat, immediate = false) {
    clearTimeout(flushTimers.get(chat.id));
    if (immediate) {
      flushTimers.delete(chat.id);
      store.save(chat);
    } else
      flushTimers.set(
        chat.id,
        setTimeout(() => {
          flushTimers.delete(chat.id);
          try {
            store.save(chat);
          } catch (e) {
            saveError(e);
          }
        }, 300),
      );
  }
  function publish(chat) {
    event('chat', { chat });
  }
  async function prepareRuntime() {
    if (runtime) return runtime;
    await updater.initialize();
    const resolved = resolveRuntime({
      appDirectory,
      dataDirectory: root,
      developmentDirectory: app.isPackaged
        ? undefined
        : path.join(__dirname, '..'),
      codeOverride: process.env.PORTABLE_CODEX_EXE,
      pythonOverride: process.env.PORTABLE_PYTHON_EXE,
    });
    runtime = {
      ...resolved,
      codex: process.env.PORTABLE_CODEX_EXE || (await updater.executable()),
    };
    configurePythonOverlay(runtime.python, root);
    if (!fs.existsSync(runtime.codex))
      throw new Error(
        '找不到所选 CLI 版本。请在连接设置中恢复上一版或重新解压完整程序。',
      );
    return runtime;
  }
  async function backend(forUpdate = false) {
    if ((updater.busy || maintenance || benchmark.status().busy) && !forUpdate)
      throw new Error('正在测速或更新，请等待完成后再发送。');
    if (starting) return starting;
    if (rpc?.process) {
      await rpc.start();
      return rpc;
    }
    const epoch = backendEpoch;
    starting = (async () => {
      if (!store.settings.apiKey)
        throw new Error('请先在设置中填写中转 API Key。');
      const run = await prepareRuntime();
      if (epoch !== backendEpoch) throw cancelled();
      const connectionFile = await browser.start();
      const py = path.dirname(run.python);
      const env = {
        PATH: [
          py,
          path.join(py, 'Scripts'),
          path.dirname(run.codex),
          path.join(path.dirname(path.dirname(run.codex)), 'codex-path'),
          process.env.PATH,
        ].join(path.delimiter),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_CACHE_DIR: path.join(root, 'cache', 'pip'),
        PORTABLE_PYTHON: run.python,
      };
      const client = new CodexRpc({
        executable: run.codex,
        home: path.join(root, 'codex-home'),
        settings: { ...store.settings },
        browser: {
          python: run.python,
          script: path.join(path.dirname(run.tools), 'browser_mcp.py'),
          connectionFile,
        },
        env,
        log,
      });
      rpc = client;
      resumed.clear();
      byThread.clear();
      rpc.on('notification', notification);
      rpc.on('question', question);
      rpc.on('offline', () => {
        resumed.clear();
        for (const summary of store.list()) {
          const c = store.get(summary.id);
          if (c.busy) {
            c.busy = false;
            c.status = '连接已断开';
            try {
              save(c, true);
            } catch (e) {
              saveError(e);
            }
            publish(c);
          }
        }
        event('status', { message: '等待重新连接' });
      });
      await client.start();
      if (epoch !== backendEpoch) {
        client.close();
        throw cancelled();
      }
      event('status', { message: '就绪' });
      return client;
    })().finally(() => {
      if (epoch === backendEpoch) starting = null;
    });
    return starting;
  }
  async function stopBackend() {
    if (starting) await starting.catch(() => {});
    const old = rpc;
    rpc = null;
    runtime = null;
    resumed.clear();
    byThread.clear();
    if (old?.process) {
      const child = old.process;
      const exited =
        child.pid && child.exitCode === null && child.signalCode === null
          ? new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error('CLI 后台进程仍在退出，请稍后再更新。'));
              }, 12000);
              child.once('close', () => {
                clearTimeout(timer);
                resolve();
              });
            })
          : Promise.resolve();
      old.close();
      await exited;
    }
  }
  function requireIdle() {
    if (starting || benchmark.status().busy || store.list().some((c) => c.busy))
      throw new Error('请等待当前任务或测速完成，再更新 CLI。');
  }
  async function changeCli(operation) {
    requireIdle();
    if (maintenance || updater.busy)
      throw new Error('CLI 正在检查或更新，请稍候。');
    maintenance = true;
    try {
      await prepareRuntime();
      return await updater[operation]();
    } finally {
      maintenance = false;
    }
  }
  function question(message) {
    const chat = byThread.get(message.params?.threadId);
    if (!chat?.busy || !operations.has(chat.id)) return;
    questions.set(String(message.id), message);
    if (chat) {
      chat.pendingQuestions ||= [];
      chat.pendingQuestions.push({
        requestId: message.id,
        questions: message.params?.questions || [],
      });
      chat.status = '等你回答';
      if (chat.tasks?.at(-1)) chat.tasks.at(-1).phase = '等你回答';
      save(chat, true);
      publish(chat);
      event('history', { chats: store.list() });
    }
    event('question', {
      requestId: message.id,
      chatId: chat?.id,
      questions: message.params?.questions || [],
    });
  }
  function clearQuestions(chat) {
    for (const q of chat.pendingQuestions || [])
      questions.delete(String(q.requestId));
    chat.pendingQuestions = [];
  }
  function answerQuestion(id, answers) {
    const q = questions.get(String(id));
    if (!q || !rpc) throw new Error('问题已过期，请重试该任务。');
    const chat = byThread.get(q.params?.threadId);
    for (const item of q.params?.questions || [])
      if (!answers[item.id]?.answers?.some((v) => String(v).trim()))
        throw new Error('请回答每一个问题后继续。');
    rpc.send({ id: q.id, result: { answers } });
    questions.delete(String(id));
    if (chat) {
      chat.pendingQuestions = (chat.pendingQuestions || []).filter(
        (q) => String(q.requestId) !== String(id),
      );
      chat.status = '继续处理';
      save(chat, true);
      publish(chat);
    }
    pet.schedule();
    event('history', { chats: store.list() });
    return true;
  }
  function notification(message) {
    try {
      applyNotification(message);
    } catch (error) {
      saveError(error);
      const c = byThread.get(message.params?.threadId);
      if (c) publish(c);
    }
  }
  function applyNotification({ method, params: p = {} }) {
    const chat = byThread.get(p.threadId);
    if (!chat) return;
    const operation = operations.get(chat.id);
    if (!operation || operation.controller.signal.aborted) return;
    if (p.turnId && chat.turnId && p.turnId !== chat.turnId) return;
    const progressOnly = updateProgress(chat, method, p, store.secrets());
    if (progressOnly) {
      save(chat);
      if (
        method === 'item/commandExecution/outputDelta' ||
        method === 'item/mcpToolCall/progress'
      ) {
        if (!progressTimers.has(chat.id))
          progressTimers.set(
            chat.id,
            setTimeout(() => {
              progressTimers.delete(chat.id);
              publish(chat);
            }, 200),
          );
      } else publish(chat);
      return;
    }
    if (chat.tasks?.at(-1) && chat.busy) chat.tasks.at(-1).phase = chat.status;
    if (method === 'turn/started') {
      chat.turnId = p.turn?.id;
      chat.busy = true;
      chat.status = '正在处理';
      save(chat);
      publish(chat);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      let m = chat.messages.find((m) => m.id === p.itemId);
      if (!m) {
        m = {
          id: p.itemId,
          role: 'assistant',
          text: '',
          createdAt: Date.now(),
          streaming: true,
        };
        chat.messages.push(m);
      }
      m.text += p.delta;
      save(chat);
      event('delta', { chatId: chat.id, itemId: m.id, delta: p.delta });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item || {};
      if (item.type === 'agentMessage') {
        let m = chat.messages.find((m) => m.id === item.id);
        if (!m) {
          m = {
            id: item.id,
            role: 'assistant',
            text: '',
            createdAt: Date.now(),
          };
          chat.messages.push(m);
        }
        if (method === 'item/completed') {
          m.text = item.text || m.text;
          m.streaming = false;
          m.phase = item.phase;
        }
      } else if (
        [
          'commandExecution',
          'fileChange',
          'webSearch',
          'mcpToolCall',
          'imageView',
          'imageGeneration',
          'plan',
          'reasoning',
          'dynamicToolCall',
        ].includes(item.type)
      ) {
        let action = chat.activity.find((a) => a.id === item.id);
        if (!action) {
          action = { id: item.id, type: item.type, startedAt: Date.now() };
          chat.activity.push(action);
        }
        if (chat.activity.length > 150)
          chat.activity = chat.activity.slice(-150);
        Object.assign(action, {
          done: method === 'item/completed',
          command: item.command,
          query: item.query,
          text: item.text,
          exitCode: item.exitCode,
          output: redact(
            item.aggregatedOutput || action.output || '',
            store.secrets(),
          ).slice(-12000),
          taskId: operation.task?.id,
          tool: item.tool,
          failed:
            (typeof item.exitCode === 'number' && item.exitCode !== 0) ||
            item.status === 'failed',
          changes: item.changes?.map((c) => c.path),
        });
        const labels = {
          commandExecution: '正在处理文件',
          fileChange: '正在保存文件',
          webSearch: '正在搜索网络',
          mcpToolCall: '正在使用工具',
          imageView: '正在查看图片',
          imageGeneration: '正在生成图片',
          reasoning: '正在思考',
          plan: '正在安排步骤',
          dynamicToolCall: '正在使用工具',
        };
        chat.status =
          operation.task?.progress?.headline || labels[item.type] || '正在处理';
      }
      save(chat);
      publish(chat);
      return;
    }
    if (method === 'error') {
      const message = p.error?.message || p.message || '请求失败';
      chat.status = redact(message, store.secrets());
      if (!p.willRetry) {
        chat.messages.push({
          id: crypto.randomUUID(),
          role: 'error',
          text: chat.status,
          createdAt: Date.now(),
        });
      }
      save(chat);
      publish(chat);
      return;
    }
    if (method === 'turn/completed') {
      finishTask(chat, p.turn).catch((e) => {
        chat.busy = false;
        chat.turnId = null;
        chat.status = '部分完成';
        chat.failure = failure(e);
        try {
          save(chat, true);
        } catch {}
        publish(chat);
        operations.delete(chat.id);
      });
      return;
    }
  }
  async function finishTask(chat, turn) {
    const operation = operations.get(chat.id),
      task = chat.tasks?.at(-1);
    if (operation?.finishing) return;
    if (operation) operation.finishing = true;
    clearQuestions(chat);
    chat.turnId = null;
    chat.updatedAt = Date.now();
    chat.status = '正在校验结果';
    if (task) task.phase = '校验文件';
    publish(chat);
    if (task) {
      const run = await prepareRuntime(),
        artifacts = await validateOutputs(
          task,
          run.python,
          run.tools,
          operation?.controller.signal,
        );
      if (operation?.controller.signal.aborted) return;
      task.artifacts = artifacts;
      task.completedAt = Date.now();
      task.status = turn?.status || 'completed';
    }
    if (operation?.controller.signal.aborted) return;
    chat.busy = false;
    chat.status = task
      ? taskOutcome(task, turn?.status)
      : turn?.status === 'interrupted'
        ? '已停止'
        : turn?.status === 'failed'
          ? '处理失败'
          : '已回答';
    for (const m of chat.messages) m.streaming = false;
    if (turn?.error?.message) {
      const text = redact(turn.error.message, store.secrets());
      chat.failure = failure(turn.error);
      if (!chat.messages.some((m) => m.role === 'error' && m.text === text))
        chat.messages.push({
          id: crypto.randomUUID(),
          role: 'error',
          text,
          createdAt: Date.now(),
        });
    }
    operations.delete(chat.id);
    save(chat, true);
    publish(chat);
    event('history', { chats: store.list() });
    event('outputs-changed', { chatId: chat.id });
    pet.taskFinished(chat);
  }
  async function attach(chat, operation) {
    const signal = operation?.controller.signal;
    const client = await abortable(backend(), signal);
    signal?.throwIfAborted();
    const run = await prepareRuntime();
    const output = operation?.task.output || path.join(chat.directory, '输出');
    fs.mkdirSync(output, { recursive: true });
    const params = {
      cwd: chat.directory,
      model: store.settings.model,
      modelProvider: 'portable_relay',
      serviceTier: store.settings.fastMode !== false ? 'fast' : 'default',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: instructions({
        ...run,
        output,
        directory: chat.directory,
        browserTaskId: operation?.task.id,
      }),
    };
    if (!chat.threadId) {
      const result = await abortable(
        client.request('thread/start', params),
        signal,
      );
      signal?.throwIfAborted();
      chat.threadId = result.thread.id;
      byThread.set(chat.threadId, chat);
      resumed.add(chat.threadId);
      save(chat, true);
      if (chat.inheritedHistory) {
        const items = inheritedInputItems(chat);
        if (items.length)
          await client.request('thread/inject_items', {
            threadId: chat.threadId,
            items,
          });
        chat.inheritedHistory = false;
        save(chat, true);
      }
    } else if (!resumed.has(chat.threadId)) {
      byThread.set(chat.threadId, chat);
      try {
        await abortable(
          client.request('thread/resume', {
            ...params,
            threadId: chat.threadId,
          }),
          signal,
        );
        signal?.throwIfAborted();
        resumed.add(chat.threadId);
      } catch (error) {
        if (
          !chat.inheritedFrom ||
          !/not found|no rollout|missing|does not exist|failed to (?:load|read).*thread/i.test(
            error.message,
          )
        )
          throw error;
        byThread.delete(chat.threadId);
        chat.inheritedThreadId = chat.threadId;
        const result = await client.request('thread/start', params);
        chat.threadId = result.thread.id;
        byThread.set(chat.threadId, chat);
        resumed.add(chat.threadId);
        const items = inheritedInputItems(chat);
        if (items.length)
          await client.request('thread/inject_items', {
            threadId: chat.threadId,
            items,
          });
        save(chat, true);
      }
    } else {
      byThread.set(chat.threadId, chat);
      await abortable(
        client.request('thread/resume', {
          ...params,
          threadId: chat.threadId,
          excludeTurns: true,
        }),
        signal,
      );
      signal?.throwIfAborted();
    }
    return client;
  }
  async function describeFiles(files) {
    if (!Array.isArray(files) || files.length > 100)
      throw new Error('一次最多添加 100 个文件。');
    const result = [];
    for (const f of files) {
      const full = path.resolve(typeof f === 'string' ? f : f.path);
      const st = await fs.promises.stat(full);
      if (!st.isFile())
        throw new Error('请添加文件，文件夹请通过“工作目录”选择。');
      const item = {
        path: full,
        name: path.basename(full),
        size: st.size,
        image: /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(full),
      };
      if (item.image && nativeImage && st.size <= MAX_IMAGE_BYTES) {
        try {
          item.thumbnail = imageThumbnail(nativeImage.createFromPath(full));
        } catch {}
      }
      result.push(item);
    }
    return result;
  }
  function handle(name, fn) {
    ipcMain.handle('portable:' + name, async (e, ...args) => {
      if (e.sender !== window?.webContents) throw new Error('无效请求来源。');
      try {
        return await fn(...args);
      } catch (error) {
        const message = redact(error.message, store.secrets());
        log(name + ': ' + message);
        throw new Error(message);
      }
    });
    actions.set(name, fn);
  }
  handle('initialize', async () => {
    await updater.initialize();
    const chats = store.list();
    if (!currentChatId) currentChatId = chats[0]?.id || null;
    return {
      settings: store.publicSettings(),
      chats,
      dataDirectory: root,
      version: app.getVersion(),
      cli: updater.status(),
      benchmark: benchmark.status(),
      pet: pet.status(),
      inheritance: inheritanceInfo,
      onboarding: !workspace.value.onboarded,
    };
  });
  handle('preferences', (update) => workspace.preference(update));
  handle('browser-status', async () => {
    await browser.start();
    return { ...browser.status(), pairUrl: browser.pairUrl() };
  });
  handle('browser-extension-folder', async () => {
    const directory = app.isPackaged
      ? path.join(appDirectory, 'browser-extension')
      : path.join(__dirname, '..', 'browser-extension');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  });
  handle('browser-focus', async (id) => {
    await browser.start();
    return browser.request(id || currentChatId || 'preview', 'focus');
  });
  handle('browser-resume', async (id) => {
    const chat = store.get(id),
      task = chat.tasks?.at(-1);
    if (
      chat.busy ||
      operations.has(id) ||
      updater.busy ||
      maintenance ||
      benchmark.status().busy
    )
      throw new Error('请先等待或停止当前任务，再继续采集。');
    if (!task?.collection) throw new Error('没有可继续的采集断点。');
    await browser.start();
    if (!browser.status().connected)
      throw new Error('请先连接浏览器扩展，再继续采集。');
    const operation = { controller: new AbortController(), task };
    operations.set(id, operation);
    chat.busy = true;
    task.status = 'running';
    chat.failure = null;
    delete task.completedAt;
    publish(chat);
    (async () => {
      try {
        await collector.collect({
          task,
          session: id,
          urls: [],
          commentPages:
            readJson(task.collection.checkpoint, {}).commentPages || 5,
          signal: operation.controller.signal,
        });
        await finishTask(chat, { status: 'completed' });
      } catch (error) {
        if (!operation.controller.signal.aborted) {
          chat.failure = failure(error);
          await finishTask(chat, {
            status: 'failed',
            error: { message: error.message },
          });
        }
      }
    })().catch((e) => log('Browser resume: ' + e.message));
    return true;
  });
  handle('get-draft', (id) => workspace.draft(id || 'new'));
  handle('save-draft', (id, draft) => {
    const result = workspace.saveDraft(id || 'new', draft);
    event('draft', { chatId: id || 'new', draft: result });
    return result;
  });
  handle('pet-status', () => pet.status());
  handle('pet-configure', (update) => {
    const result = pet.configure(update);
    event('pet-settings', { settings: result });
    return result;
  });
  handle('pet-quick', () => {
    pet.showQuick();
    return true;
  });
  handle('app-quit', () => requestQuit());
  handle('benchmark-status', () => benchmark.status());
  handle('benchmark-run', () => {
    requireSettingsIdle();
    return benchmark.run();
  });
  handle('benchmark-cancel', () => benchmark.cancel());
  handle('cli-status', async () => {
    await updater.initialize();
    return updater.status();
  });
  handle('cli-check', () => updater.check());
  handle('cli-update', () => changeCli('install'));
  handle('cli-rollback', () => changeCli('rollback'));
  handle('cli-cancel', () => updater.cancel());
  handle('select-directory', async () => {
    const r = await dialog.showOpenDialog(window, {
      title: '选择工作目录',
      defaultPath: store.settings.lastDirectory || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('create-chat', (directory) => {
    const c = store.create(directory);
    currentChatId = c.id;
    store.saveSettings({ lastDirectory: c.directory });
    event('history', { chats: store.list() });
    return c;
  });
  handle('get-chat', (id) => {
    currentChatId = id;
    const chat = store.get(id);
    pet.acknowledge(id);
    return chat;
  });
  handle('list-chats', () => store.list());
  handle('list-archived', () => store.archived());
  handle('restore-chat', (id) => {
    const chat = store.restore(id);
    event('history', { chats: store.list() });
    return chat;
  });
  handle('pending-questions', (id) => store.get(id).pendingQuestions || []);
  handle('relocate-chat', async (id) => {
    const chat = store.get(id);
    if (chat.busy) throw new Error('请先停止任务。');
    const result = await dialog.showOpenDialog(window, {
      title: '为这段对话重新定位工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    const previous = chat.directory;
    chat.directory = result.filePaths[0];
    const moved = (file) => {
      if (!file || fs.existsSync(file)) return file;
      const relative = path.relative(previous, file),
        replacement = path.join(chat.directory, relative);
      return !relative.startsWith('..') && fs.existsSync(replacement)
        ? replacement
        : fs.existsSync(path.join(chat.directory, path.basename(file)))
          ? path.join(chat.directory, path.basename(file))
          : file;
    };
    if (chat.lastRequest)
      chat.lastRequest.files = chat.lastRequest.files.map(moved);
    for (const task of chat.tasks || []) {
      task.output = moved(task.output);
      for (const file of task.artifacts || []) file.path = moved(file.path);
    }
    for (const message of chat.messages)
      for (const file of message.attachments || [])
        file.path = moved(file.path);
    resumed.delete(chat.threadId);
    save(chat, true);
    publish(chat);
    event('history', { chats: store.list() });
    return chat;
  });
  handle('retry', async (id, profileId) => {
    const chat = store.get(id);
    if (chat.busy) throw new Error('当前仍在运行。');
    if (!chat.lastRequest) throw new Error('没有可以重试的请求。');
    if (profileId && profileId !== store.settings.activeProfileId)
      await changeSettings(() => store.selectProfile(profileId));
    const request = chat.lastRequest,
      files = request.files.map((file) =>
        fs.existsSync(file)
          ? file
          : chat.tasks
              ?.flatMap((t) => t.originals || [])
              .find(
                (o) => o.sourcePath === file && fs.existsSync(o.originalPath),
              )?.originalPath || file,
      );
    return actions.get('send')(id, request.text, files);
  });
  handle('rename-chat', (id, title) => {
    const c = store.get(id);
    c.title = String(title).trim().slice(0, 100) || '新对话';
    save(c, true);
    event('history', { chats: store.list() });
    return c;
  });
  handle('archive-chat', (id) => {
    store.archive(id);
    event('history', { chats: store.list() });
    return true;
  });
  handle('send', async (id, text, files = []) => {
    if (updater.busy || maintenance || benchmark.status().busy)
      throw new Error('正在测速或更新，请稍候再发送。');
    const chat = store.get(id);
    if (chat.busy || operations.has(id))
      throw new Error('当前任务仍在处理中，请先等待或停止。');
    text = String(text || '').trim();
    if (text.length > 200000) throw new Error('消息过长，请保存为文件后添加。');
    chat.lastRequest = {
      text,
      files: files.map((f) => (typeof f === 'string' ? f : f.path)),
    };
    const operation = { controller: new AbortController(), task: null };
    operations.set(id, operation);
    const signal = operation.controller.signal;
    chat.busy = true;
    chat.status = '准备文件';
    chat.updatedAt = Date.now();
    chat.failure = null;
    clearQuestions(chat);
    publish(chat);
    try {
      if (!fs.existsSync(chat.directory))
        throw Object.assign(new Error('工作目录已移动或不存在。'), {
          code: 'ENOENT',
        });
      const attachments = await abortable(describeFiles(files), signal);
      signal.throwIfAborted();
      if (!text && !attachments.length)
        throw new Error('请输入消息或添加文件。');
      const task = newTask(chat, text, attachments);
      operation.task = task;
      chat.tasks ||= [];
      chat.tasks.push(task);
      if (chat.tasks.length > 80) chat.tasks = chat.tasks.slice(-80);
      chat.lastRequest = { text, files: attachments.map((f) => f.path) };
      if (chat.title === '新对话')
        chat.title = (text || attachments[0]?.name || '文件处理')
          .replace(/\s+/g, ' ')
          .slice(0, 30);
      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text,
        attachments,
        createdAt: Date.now(),
        taskId: task.id,
      };
      chat.messages.push(userMessage);
      save(chat, true);
      event('history', { chats: store.list() });
      publish(chat);
      task.originals = await abortable(
        snapshotInputs(root, task, attachments, signal),
        signal,
      );
      signal.throwIfAborted();
      task.phase = '连接模型';
      chat.status = '正在连接';
      save(chat, true);
      publish(chat);
      const client = await attach(chat, operation);
      signal.throwIfAborted();
      const fileText = task.originals.length
        ? '\n\n已创建本地任务副本，使用工具读取并处理副本：\n' +
          task.originals
            .map((f) => '- ' + f.name + ': ' + JSON.stringify(f.path))
            .join('\n')
        : '';
      const input = [
        {
          type: 'text',
          text:
            (text || '请查看这些文件并说明可以如何处理。') +
            fileText +
            '\n本次成果目录：' +
            task.output,
        },
        ...task.originals
          .filter((f) => f.image)
          .map((f) => ({ type: 'localImage', path: f.path })),
      ];
      task.phase = '等待模型';
      chat.status = '正在思考';
      publish(chat);
      const request = client.request(
        'turn/start',
        {
          threadId: chat.threadId,
          cwd: chat.directory,
          input,
          model: store.settings.model,
          effort: store.settings.reasoningEffort || 'xhigh',
          serviceTier: store.settings.fastMode !== false ? 'fast' : 'default',
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
        90000,
      );
      request
        .then((result) => {
          if (signal.aborted && client.process)
            client
              .request('turn/interrupt', {
                threadId: chat.threadId,
                turnId: result.turn.id,
              })
              .catch(() => {});
        })
        .catch(() => {});
      const result = await abortable(request, signal);
      signal.throwIfAborted();
      if (chat.busy && !operation.finishing) chat.turnId = result.turn.id;
      save(chat, true);
      publish(chat);
      const draft = workspace.draft(id);
      if (
        draft.text === text &&
        JSON.stringify(draft.attachments.map((f) => f.path)) ===
          JSON.stringify(files)
      )
        workspace.clearDraft(id);
      event('draft', { chatId: id, draft: workspace.draft(id) });
      return { accepted: true };
    } catch (error) {
      if (operations.get(id) !== operation && operations.has(id))
        return { accepted: false, cancelled: true };
      const stop = signal.aborted;
      chat.busy = false;
      chat.turnId = null;
      clearQuestions(chat);
      chat.status = stop ? '已停止' : '未能完成';
      chat.updatedAt = Date.now();
      chat.failure = stop ? null : failure(error);
      if (operation.task) {
        operation.task.status = stop ? 'interrupted' : 'failed';
        operation.task.completedAt = Date.now();
      }
      if (!stop)
        chat.messages.push({
          id: crypto.randomUUID(),
          role: 'error',
          text: redact(error.message, store.secrets()),
          createdAt: Date.now(),
          friendly: chat.failure,
        });
      if (operations.get(id) === operation) operations.delete(id);
      try {
        save(chat, true);
      } catch (e) {
        saveError(e);
      }
      publish(chat);
      event('history', { chats: store.list() });
      if (!stop) pet.taskFinished(chat);
      if (stop) return { accepted: false, cancelled: true };
      throw error;
    }
  });
  handle('stop', async (id) => {
    const chat = store.get(id),
      operation = operations.get(id);
    if (!chat.busy && !operation) return true;
    operation?.controller.abort();
    clearQuestions(chat);
    chat.status = '正在停止';
    publish(chat);
    const turnId = chat.turnId,
      client = rpc;
    if (turnId && client?.process) {
      try {
        await client.request('turn/interrupt', {
          threadId: chat.threadId,
          turnId,
        });
      } catch (e) {
        if (!/no active turn|not found|not.*progress/i.test(e.message))
          log('interrupt: ' + e.message);
      }
    } else if (
      ![...operations].some(([other]) => other !== id && store.get(other).busy)
    ) {
      backendEpoch++;
      rpc = null;
      client?.close();
      starting = null;
      resumed.clear();
      byThread.clear();
    }
    chat.busy = false;
    chat.turnId = null;
    chat.status = '已停止';
    chat.updatedAt = Date.now();
    if (operation?.task) {
      operation.task.status = 'interrupted';
      operation.task.completedAt = Date.now();
    }
    operations.delete(id);
    try {
      save(chat, true);
    } catch (e) {
      saveError(e);
    }
    publish(chat);
    event('history', { chats: store.list() });
    return true;
  });
  handle('select-files', async () => {
    const r = await dialog.showOpenDialog(window, {
      title: '添加文件',
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : describeFiles(r.filePaths);
  });
  handle('describe-files', describeFiles);
  handle('import-image', (bytes, name) =>
    storeImage(root, bytes, nativeImage, name),
  );
  handle('paste-image', () => clipboardImage(root, clipboard, nativeImage));
  handle('list-files', async (id) => scanFiles(store.get(id).directory));
  handle('output-files', async (id) => {
    const c = store.get(id);
    return c.tasks?.length
      ? c.tasks.at(-1).artifacts || []
      : (
          await scanFiles(path.join(c.directory, '输出'), {
            limit: 300,
            depth: 4,
          })
        ).sort((a, b) => b.modified - a.modified);
  });
  function taskFile(id, taskId, file) {
    const chat = store.get(id),
      task = chat.tasks?.find((t) => t.id === taskId);
    if (!task) throw new Error('找不到这次任务。');
    if (!task.artifacts.some((f) => f.path === file))
      throw new Error('文件不属于这次任务。');
    return { chat, task };
  }
  handle('save-result', async (id, taskId, file) => {
    taskFile(id, taskId, file);
    const result = await dialog.showSaveDialog(window, {
      title: '将结果另存为',
      defaultPath: path.basename(file),
    });
    if (result.canceled) return null;
    if (path.resolve(result.filePath) !== path.resolve(file))
      await fs.promises.copyFile(file, result.filePath);
    return result.filePath;
  });
  handle('zip-results', async (id, taskId) => {
    const chat = store.get(id),
      task = chat.tasks?.find((t) => t.id === taskId);
    if (!task?.artifacts.length) throw new Error('本次没有生成文件。');
    const result = await dialog.showSaveDialog(window, {
      title: '打包本次结果',
      defaultPath: task.title + '.zip',
    });
    if (result.canceled) return null;
    return zipFiles(
      result.filePath,
      task.artifacts.map((f) => ({ path: f.path, name: f.relative || f.name })),
    );
  });
  handle('restore-original', async (id, taskId, index) => {
    const chat = store.get(id),
      task = chat.tasks?.find((t) => t.id === taskId),
      original = task?.originals[index];
    if (!original) throw new Error('找不到原件快照。');
    const result = await dialog.showSaveDialog(window, {
      title: '恢复原件副本',
      defaultPath: '原始-' + original.name,
    });
    if (result.canceled) return null;
    await fs.promises.copyFile(original.originalPath, result.filePath);
    return result.filePath;
  });
  handle('open', async (target, id) => {
    if (typeof target !== 'string' || target.length > 32768)
      throw new Error('无效文件路径。');
    if (/^https?:\/\//i.test(target)) {
      const u = new URL(target);
      if (u.username || u.password) throw new Error('无效网址。');
      await shell.openExternal(u.href);
      return true;
    }
    let f = target;
    if (f.startsWith('file:')) f = fileURLToPath(f);
    else {
      try {
        f = decodeURIComponent(f);
      } catch {}
    }
    // Markdown may append source line numbers to a local link.
    f = f.replace(/:\d+(?::\d+)?$/, '');
    if (!path.isAbsolute(f)) {
      if (!id) throw new Error('无法定位文件。');
      f = path.resolve(store.get(id).directory, f);
    }
    const st = await fs.promises.stat(f);
    if (
      st.isFile() &&
      /\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|msi|msix|scr|lnk|url|reg|hta)$/i.test(
        f,
      )
    ) {
      shell.showItemInFolder(f);
      return true;
    }
    const error = await shell.openPath(f);
    if (error) throw new Error('无法打开文件：' + error);
    return true;
  });
  handle('reveal', async (target) => {
    if (!path.isAbsolute(target)) throw new Error('无效路径');
    await fs.promises.stat(target);
    shell.showItemInFolder(target);
    return true;
  });
  function requireSettingsIdle() {
    if (updater.busy || maintenance || benchmark.status().busy)
      throw new Error('正在测速或更新，请稍候再修改设置。');
    if (store.list().some((c) => c.busy))
      throw new Error('请等待当前任务完成，再修改连接设置。');
  }
  async function changeSettings(action) {
    requireSettingsIdle();
    maintenance = true;
    try {
      await stopBackend();
      const result = action();
      event('settings', { settings: result });
      return result;
    } finally {
      maintenance = false;
    }
  }
  handle('save-settings', (settings) =>
    changeSettings(() => store.saveSettings(settings)),
  );
  handle('select-profile', (id) =>
    changeSettings(() => store.selectProfile(id)),
  );
  handle('delete-profile', (id) =>
    changeSettings(() => store.deleteProfile(id)),
  );
  async function fetchModels(s) {
    if (!s.apiKey) throw new Error('请填写这套中转配置的 API Key。');
    const request = net ? net.fetch.bind(net) : fetch;
    const response = await request(s.baseUrl.replace(/\/$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + s.apiKey },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      throw new Error(
        '中转站返回 HTTP ' + response.status + '，请检查地址和 Key。',
      );
    const json = await response.json();
    return [
      ...new Set(
        (Array.isArray(json.data) ? json.data : [])
          .map((x) => (typeof x === 'string' ? x : x?.id))
          .filter((x) => typeof x === 'string'),
      ),
    ].slice(0, 1000);
  }
  handle('profile-models', async (draft) => {
    const profile = store.resolveProfile(draft),
      models = await fetchModels(profile);
    return {
      models: modelCatalog(models),
      modelFound: models.includes(profile.model),
    };
  });
  handle('test-connection', async () => {
    const s = store.settings,
      models = await fetchModels(s);
    store.setModelCatalog(s.activeProfileId, models);
    const settings = store.publicSettings();
    event('settings', { settings });
    return {
      ok: true,
      modelFound: models.includes(s.model),
      models: modelCatalog(models),
      settings,
    };
  });
  handle('export-chat', async (id) => {
    const c = store.get(id);
    const r = await dialog.showSaveDialog(window, {
      title: '导出对话',
      defaultPath: path.join(
        c.directory,
        c.title.replace(/[<>:"/\\|?*]/g, '_') + '.md',
      ),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled) return null;
    const text =
      '# ' +
      c.title +
      '\n\n' +
      c.messages
        .map(
          (m) =>
            '## ' +
            (m.role === 'user' ? '我' : m.role === 'error' ? '提示' : 'Codex') +
            '\n\n' +
            m.text +
            (m.attachments?.length
              ? '\n\n' + m.attachments.map((f) => '- ' + f.path).join('\n')
              : ''),
        )
        .join('\n\n');
    await fs.promises.writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  });
  handle('answer', answerQuestion);
  handle('diagnostics', async () => {
    const report = {
      version: app.getVersion(),
      platform: process.platform,
      cli: updater.status().currentVersion,
      petRenderer: pet.renderer,
      inheritanceCompleted: readJson(path.join(root, 'inheritance.json'), {})
        .completed,
      errors: store
        .list()
        .map((s) => store.get(s.id).failure)
        .filter(Boolean)
        .map((e) => ({ kind: e.kind, message: e.message })),
    };
    const result = await dialog.showSaveDialog(window, {
      title: '导出去除令牌和对话正文的诊断',
      defaultPath: '文件助手诊断.json',
    });
    if (result.canceled) return null;
    await fs.promises.writeFile(
      result.filePath,
      JSON.stringify(report, null, 2),
    );
    return result.filePath;
  });
  handle('backup-data', async () => {
    requireSettingsIdle();
    await stopBackend();
    const result = await dialog.showSaveDialog(window, {
      title: '备份历史、附件和个人配置',
      defaultPath:
        '文件助手备份-' + new Date().toISOString().slice(0, 10) + '.tar.gz',
    });
    if (result.canceled) return null;
    return backupData(root, result.filePath);
  });
  handle('import-data', async (mode) => {
    requireSettingsIdle();
    maintenance = true;
    let temp = null;
    try {
      await stopBackend();
      const result = await dialog.showOpenDialog(window, {
        title:
          mode === 'backup' ? '选择数据备份' : '选择旧版程序目录或 data 文件夹',
        properties: mode === 'backup' ? ['openFile'] : ['openDirectory'],
      });
      if (result.canceled) return null;
      let source = result.filePaths[0],
        data;
      if (mode === 'backup') {
        temp = path.join(root, 'imports', crypto.randomUUID());
        data = path.join(temp, 'data');
        await extractBackup(source, data);
        source = temp;
      } else
        data = fs.existsSync(path.join(source, 'settings.json'))
          ? source
          : path.join(source, 'data');
      if (
        !fs.existsSync(path.join(data, 'settings.json')) &&
        !fs.existsSync(path.join(data, 'conversations'))
      )
        throw new Error('此目录没有可导入的助手数据。');
      if (path.resolve(data) === path.resolve(root))
        throw new Error('请选择其他旧版目录。');
      const report = await new Inheritor({
        appDirectory,
        root,
        version: app.getVersion(),
      }).run([
        {
          directory: source,
          data,
          version: '手动导入',
          key: crypto
            .createHash('sha256')
            .update(data)
            .digest('hex')
            .slice(0, 12),
        },
      ]);
      store = new Store(root, preset);
      workspace.value = readJson(workspace.file, workspace.value);
      workspace.value.drafts ||= {};
      pet.settings = require('./pet-state.cjs').normalizePetSettings(
        readJson(path.join(root, 'pet.json'), {}),
      );
      event('history', { chats: store.list() });
      event('settings', { settings: store.publicSettings() });
      return report;
    } finally {
      maintenance = false;
      currentChatId = null;
      resumed.clear();
      byThread.clear();
      if (temp)
        await fs.promises
          .rm(temp, { recursive: true, force: true })
          .catch(() => {});
    }
  });

  function createWindow() {
    window = new BrowserWindow({
      width: 1220,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      title: 'Codex Portable',
      backgroundColor: '#fcfbf8',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.loadFile(path.join(__dirname, 'ui', 'index.html'));
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    window.on('close', (e) => {
      if (
        !quitting &&
        pet.settings.closeToTray &&
        (pet.tray || (pet.settings.enabled && pet.window))
      ) {
        e.preventDefault();
        window.hide();
        if (pet.settings.enabled) pet.show();
        if (!workspace.value.trayExplained) {
          workspace.preference({ trayExplained: true });
          if (
            process.platform !== 'linux' ||
            process.env.DISPLAY ||
            process.env.WAYLAND_DISPLAY
          )
            dialog
              .showMessageBox(window, {
                type: 'info',
                title: '助手仍在后台运行',
                message:
                  '任务继续执行。点桌宠或托盘可回来；需要退出时用桌宠右键菜单的“退出”。',
              })
              .catch(() => {});
        }
        return;
      }
      if (!quitting && (updater.busy || maintenance)) {
        e.preventDefault();
        event('error', { message: 'CLI 正在更新，请等待完成，或先取消更新。' });
        return;
      }
      if (!quitting && store.list().some((c) => c.busy)) {
        const result = dialog.showMessageBoxSync(window, {
          type: 'question',
          title: '仍有任务进行中',
          message: '关闭程序会停止当前任务。',
          buttons: ['继续等待', '停止并关闭'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result === 0) e.preventDefault();
        if (result === 0) return;
      }
      if (!quitting) {
        e.preventDefault();
        quitting = true;
        app.quit();
      }
    });
  }
  app.on('second-instance', () => showConversation());
  const launched = app
    .whenReady()
    .then(() => {
      createWindow();
      pet.registerAssets();
      setTimeout(() => {
        if (!quitting)
          try {
            pet.start();
          } catch (e) {
            log('Pet startup: ' + e.message);
          }
      }, 450);
    })
    .catch((e) => {
      dialog.showErrorBox('无法启动', redact(e.message, store.secrets()));
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (!pet.tray) app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    for (const operation of operations.values()) operation.controller.abort();
    browser.close();
    pet.shutdown();
    benchmark.cancel();
    if (rpc) rpc.close();
    for (const t of flushTimers.values()) clearTimeout(t);
    for (const t of progressTimers.values()) clearTimeout(t);
    for (const c of store.chats.values()) {
      if (c.busy) {
        c.busy = false;
        c.status = '已停止';
      }
      try {
        store.save(c);
      } catch (e) {
        log('quit save: ' + e.message);
      }
    }
  });
  process.on('uncaughtException', (error) => {
    log(error.stack || error.message);
    event('error', { message: redact(error.message, store.secrets()) });
  });
  process.on('unhandledRejection', (error) => {
    log('Unhandled rejection: ' + (error?.stack || error));
    event('error', { message: '操作未完成，请查看当前任务或稍后重试。' });
  });

  return launched;
}
if (!inheritanceInspection.needed) {
  launchApplication(inheritanceInspection.report);
} else
  app.whenReady().then(async () => {
    inheritanceWindow = new BrowserWindow({
      width: 490,
      height: 220,
      resizable: false,
      frame: false,
      title: '正在继承旧版记录',
      backgroundColor: '#fcfbf8',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    inheritanceWindow.setMenu(null);
    inheritanceWindow.loadFile(path.join(__dirname, 'ui', 'inherit.html'));
    inheritanceWindow.webContents.on('did-finish-load', () => {
      if (inheritanceWindow && !inheritanceWindow.isDestroyed())
        inheritanceWindow.webContents
          .executeJavaScript(
            'document.getElementById("progress").textContent=' +
              JSON.stringify(inheritanceProgress),
          )
          .catch(() => {});
    });
    let report;
    try {
      report = await inheritor.run(inheritanceInspection.sources);
    } catch (error) {
      report = {
        completed: false,
        newlyImported: false,
        sourceCount: inheritanceInspection.sources.length,
        error: '旧版数据尚未全部继承，下次启动会重试。',
      };
      try {
        const logs = path.join(root, 'logs');
        fs.mkdirSync(logs, { recursive: true });
        fs.appendFileSync(
          path.join(logs, 'inheritance.log'),
          new Date().toISOString() + ' ' + error.message + '\n',
        );
      } catch {}
    }
    await launchApplication(report);
    if (inheritanceWindow && !inheritanceWindow.isDestroyed())
      inheritanceWindow.destroy();
    inheritanceWindow = null;
  });
