'use strict';
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const out = path.resolve(__dirname, '../test-output/ui');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TEST_CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1220, height: 820 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let callback = () => {},
        seq = 0;
      const chats = new Map();
      const file = {
        name: '季度报告.docx',
        path: 'C:\\工作文件\\季度报告.docx',
        relative: '季度报告.docx',
        size: 20364,
      };
      const result = {
        name: '整理后的报告.docx',
        path: 'C:\\工作文件\\输出\\整理后的报告.docx',
        relative: '整理后的报告.docx',
        size: 12408,
      };
      const modelOptions = [
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
      ];
      const profiles = [
        {
          id: 'relay-default',
          name: 'axhan',
          baseUrl: 'https://api.aixhan.com/v1',
          model: modelOptions[0],
          hasApiKey: true,
          reasoningEffort: 'xhigh',
          fastMode: true,
          webSearch: true,
          models: modelOptions,
        },
        {
          id: '4router-core',
          name: '4router',
          baseUrl: 'https://4router.ai/v1',
          model: modelOptions[0],
          hasApiKey: true,
          reasoningEffort: 'xhigh',
          fastMode: true,
          webSearch: true,
          models: modelOptions,
        },
      ];
      let petSettings = {
        enabled: true,
        scale: 1,
        alwaysOnTop: true,
        notifications: true,
        quiet: false,
        closeToTray: true,
        position: null,
      };
      let profileSeq = 0;
      const settings = {
        ...profiles[0],
        profiles,
        activeProfileId: profiles[0].id,
        modelOptions,
      };
      let benchmark = {
        busy: false,
        parameters: null,
        rows: [],
        winnerId: null,
      };
      const cli = {
        currentVersion: '0.166.0',
        previousVersion: null,
        latestVersion: null,
        updateAvailable: false,
        busy: false,
        phase: 'idle',
        message: '',
      };
      const copy = (v) => structuredClone(v);
      const emit = (v) => callback(copy(v));
      const drafts = new Map();
      window.testState = {
        opened: [],
        sent: [],
        outputs: [],
        chats,
        emit,
        importedImages: 0,
      };
      window.portable = {
        initialize: async () => ({
          settings: copy(settings),
          chats: [],
          dataDirectory: 'D:\\Codex\\data',
          version: '1.0.6',
          cli: copy(cli),
          benchmark: copy(benchmark),
          pet: { settings: copy(petSettings) },
        }),
        preferences: async () => ({}),
        getDraft: async (id) =>
          copy(drafts.get(id) || { text: '', attachments: [] }),
        saveDraft: async (id, d) => {
          drafts.set(id, copy(d));
          return copy(d);
        },
        listArchived: async () => [],
        restoreChat: async () => null,
        relocateChat: async (id) => copy(chats.get(id)),
        retry: async () => true,
        diagnostics: async () => null,
        backupData: async () => null,
        importData: async () => null,
        petStatus: async () => ({ settings: copy(petSettings) }),
        configurePet: async (s) => {
          Object.assign(petSettings, s);
          return copy(petSettings);
        },
        petQuick: async () => true,
        quit: async () => true,
        cliStatus: async () => copy(cli),
        benchmarkStatus: async () => copy(benchmark),
        benchmarkRun: async () => {
          benchmark = {
            busy: true,
            parameters: {
              model: 'gpt-6.1-sol',
              reasoningEffort: 'xhigh',
              fastMode: true,
            },
            rows: profiles.map((p) => ({
              id: p.id,
              name: p.name,
              status: 'running',
              firstTokenMs: null,
              totalMs: null,
            })),
            winnerId: null,
          };
          emit({ type: 'benchmark', status: benchmark });
          await new Promise((r) => setTimeout(r, 80));
          benchmark.busy = false;
          benchmark.rows.forEach((r, i) =>
            Object.assign(r, {
              status: 'success',
              firstTokenMs: 100 + i * 50,
              totalMs: 600 - i * 100,
            }),
          );
          benchmark.winnerId = '4router-core';
          emit({ type: 'benchmark', status: benchmark });
          return copy(benchmark);
        },
        benchmarkCancel: async () => true,
        checkCli: async () => {
          Object.assign(cli, {
            latestVersion: '0.167.0',
            updateAvailable: true,
            message: '可更新到 0.167.0',
          });
          emit({ type: 'cli-update', status: cli });
          return copy(cli);
        },
        updateCli: async () => {
          Object.assign(cli, {
            busy: true,
            phase: 'downloading',
            bytes: 10,
            total: 20,
            message: '正在下载 50%',
          });
          emit({ type: 'cli-update', status: cli });
          await new Promise((r) => setTimeout(r, 80));
          Object.assign(cli, {
            currentVersion: '0.167.0',
            previousVersion: '0.166.0',
            updateAvailable: false,
            busy: false,
            phase: 'idle',
            message: '已更新到 CLI 0.167.0，可继续对话。',
          });
          emit({ type: 'cli-update', status: cli });
          return copy(cli);
        },
        rollbackCli: async () => {
          Object.assign(cli, {
            currentVersion: '0.166.0',
            previousVersion: '0.167.0',
            updateAvailable: true,
            busy: false,
            phase: 'idle',
            message: '已恢复到 CLI 0.166.0。',
          });
          emit({ type: 'cli-update', status: cli });
          return copy(cli);
        },
        cancelCliUpdate: async () => true,
        onEvent: (fn) => {
          callback = fn;
        },
        selectDirectory: async () => 'C:\\工作文件',
        createChat: async (directory) => {
          const c = {
            id: 'chat-' + ++seq,
            title: '新对话',
            directory,
            messages: [],
            activity: [],
            busy: false,
            updatedAt: Date.now(),
          };
          chats.set(c.id, c);
          return copy(c);
        },
        getChat: async (id) => copy(chats.get(id)),
        listChats: async () => [...chats.values()].map(copy),
        listFiles: async () => [file],
        outputFiles: async () => copy(window.testState.outputs),
        selectFiles: async () => [file],
        describeFiles: async (files) =>
          files.map((f) =>
            typeof f === 'string'
              ? { ...file, name: f.split(/[\\/]/).pop(), path: f }
              : f,
          ),
        filePath: (f) =>
          f.name.startsWith('clipboard') ? '' : 'C:\\工作文件\\' + f.name,
        importImage: async (bytes, name) => {
          window.testState.importedImages++;
          await new Promise((r) => setTimeout(r, 80));
          return {
            name,
            path: 'D:\\Codex\\data\\attachments\\' + name,
            size: bytes.length,
            image: true,
            thumbnail:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAHElEQVR4nGNUL09noAZgooopowaNGjRq0Ag2CADyUgElcJ4OpQAAAABJRU5ErkJggg==',
          };
        },
        pasteImage: async () => ({
          name: '截图.png',
          path: 'D:\\Codex\\data\\attachments\\截图.png',
          size: 100,
          image: true,
        }),
        send: async (id, text, files) => {
          window.testState.sent.push({ id, text, files });
          const c = chats.get(id);
          c.title = text.slice(0, 25);
          c.busy = true;
          c.status = '正在处理文件';
          c.messages.push({
            id: 'u' + seq,
            role: 'user',
            text,
            attachments: files.map((p) => ({ ...file, path: p })),
            createdAt: Date.now(),
          });
          emit({ type: 'chat', chat: c });
          emit({ type: 'history', chats: [...chats.values()] });
          setTimeout(() => {
            c.messages.push({
              id: 'a' + seq,
              role: 'assistant',
              text: '已整理好报告，保留了原文档。\n\n[打开整理后的报告](<C:/工作文件/输出/整理后的报告.docx>)\n\n- 提炼了核心结论\n- 统一了标题与段落格式',
              streaming: false,
            });
            c.busy = false;
            c.status = '已完成';
            window.testState.outputs = [result];
            emit({ type: 'chat', chat: c });
            emit({ type: 'outputs-changed', chatId: id });
          }, 100);
          return { accepted: true };
        },
        open: async (p) => {
          window.testState.opened.push(p);
          return true;
        },
        reveal: async () => true,
        saveSettings: async (s) => {
          const id =
            s.profileId === null
              ? 'custom-' + ++profileSeq
              : s.profileId || settings.activeProfileId;
          let profile = profiles.find((p) => p.id === id);
          if (!profile) {
            profile = { id, models: modelOptions };
            profiles.push(profile);
          }
          const { profileId, apiKey, ...fields } = s;
          Object.assign(profile, fields, { hasApiKey: true });
          Object.assign(settings, profile, { activeProfileId: id, profiles });
          return copy(settings);
        },
        selectProfile: async (id) => {
          Object.assign(
            settings,
            profiles.find((p) => p.id === id),
            { activeProfileId: id },
          );
          return copy(settings);
        },
        deleteProfile: async (id) => {
          const index = profiles.findIndex((p) => p.id === id);
          profiles.splice(index, 1);
          if (settings.activeProfileId === id)
            Object.assign(settings, profiles[0], {
              activeProfileId: profiles[0].id,
            });
          return copy(settings);
        },
        profileModels: async () => ({ models: modelOptions, modelFound: true }),
        testConnection: async () => ({
          ok: true,
          modelFound: true,
          models: modelOptions,
          settings: copy(settings),
        }),
        renameChat: async (id, title) => {
          const c = chats.get(id);
          c.title = title;
          return copy(c);
        },
        archiveChat: async (id) => {
          chats.delete(id);
        },
        exportChat: async () => 'C:\\工作文件\\对话.md',
        stop: async () => true,
        answer: async () => true,
      };
    });
    await page.goto(
      pathToFileURL(path.resolve(__dirname, '../src/ui/index.html')).href,
    );
    await page.waitForSelector('.welcome h1');
    await page.click('#pet-open');
    await page.waitForSelector('#pet-settings[open]');
    await page.selectOption('#pet-scale', '1.3');
    await page.check('#pet-quiet');
    await page.locator('#pet-form button[type=submit]').click();
    assert.equal(
      await page.locator('#fast-toggle').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.locator('#effort-label').textContent(),
      '思考：极高',
    );
    assert.equal(await page.locator('#model-label option').count(), 5);
    await page.click('#benchmark-open');
    await page
      .getByText(
        '本次完成最快：4router。首字越短，开始回复越快；完成时间越短，本次任务越快。',
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator('#benchmark-results tr').count(), 2);
    assert.equal(
      await page.locator('.benchmark-fastest').textContent(),
      '最快',
    );
    await page.screenshot({
      path: path.join(out, 'benchmark.png'),
      fullPage: true,
    });
    await page
      .locator('#benchmark-results tr')
      .filter({ hasText: '4router' })
      .getByText('使用', { exact: true })
      .click();
    assert.equal(
      await page.locator('#profile-switch').inputValue(),
      '4router-core',
    );
    await page.click('#benchmark-close');
    await page.selectOption('#profile-switch', 'relay-default');
    await page.selectOption('#model-label', 'gpt-6.1-terra');
    assert.equal(
      await page.locator('#model-label').inputValue(),
      'gpt-6.1-terra',
    );
    await page.selectOption('#profile-switch', '4router-core');
    assert.equal(
      await page.locator('#model-label').inputValue(),
      'gpt-6.1-sol',
    );
    await page.click('#fast-toggle');
    assert.equal(
      await page.locator('#fast-toggle').getAttribute('aria-pressed'),
      'false',
    );
    await page.click('#fast-toggle');
    assert.equal(
      await page.locator('#fast-toggle').getAttribute('aria-pressed'),
      'true',
    );
    await page.screenshot({
      path: path.join(out, 'welcome.png'),
      fullPage: true,
    });
    // Attach before choosing a folder; the selection must survive directory selection.
    await page.click('#attach');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    await page.evaluate(() => {
      const transfer = new DataTransfer(),
        png = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAHElEQVR4nGNUL09noAZgooopowaNGjRq0Ag2CADyUgElcJ4OpQAAAABJRU5ErkJggg==',
          ),
          (c) => c.charCodeAt(0),
        );
      transfer.items.add(
        new File([png], 'clipboard.png', { type: 'image/png' }),
      );
      document.getElementById('prompt').dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.locator('.attachment-chip').nth(1).waitFor();
    assert.equal(await page.locator('.attachment-thumbnail').count(), 1);
    assert.equal(await page.evaluate(() => window.testState.importedImages), 1);
    assert.equal(
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '普通文字');
        const event = new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        });
        document.getElementById('prompt').dispatchEvent(event);
        return event.defaultPrevented;
      }),
      false,
    );
    await page.screenshot({
      path: path.join(out, 'clipboard.png'),
      fullPage: true,
    });
    await page.fill('#prompt', '请帮我整理这份报告');
    await page.press('#prompt', 'Enter');
    await page.waitForSelector('.message.assistant');
    await page.waitForSelector('.file-row');
    const sent = await page.evaluate(() => window.testState.sent);
    assert.equal(sent[0].files.length, 2);
    assert.ok(sent[0].files[1].includes('attachments'));
    await page.click('.markdown a');
    assert.ok(
      decodeURIComponent(
        (await page.evaluate(() => window.testState.opened))[0],
      ).includes('整理后的报告.docx'),
    );
    await page.screenshot({
      path: path.join(out, 'conversation.png'),
      fullPage: true,
    });
    await page.click('#new-chat');
    assert.equal(await page.locator('.history-row').count(), 2);
    await page
      .locator('.history-row')
      .filter({ hasText: '请帮我整理这份报告' })
      .locator('.history-item')
      .click();
    await page.waitForSelector('.message.assistant');
    await page.fill('#prompt', '@季度');
    await page.waitForSelector('.mention-option');
    await page.press('#prompt', 'Enter');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['fake'], '图片.png', { type: 'image/png' }));
      document.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.locator('.attachment-chip').nth(1).waitFor();
    await page.click('#settings-open');
    await page.waitForSelector('#settings[open]');
    assert.equal(await page.inputValue('#setting-key'), '');
    assert.equal(await page.isChecked('#setting-fast'), true);
    assert.equal(
      await page.locator('#setting-model').evaluate((n) => n.tagName),
      'SELECT',
    );
    assert.equal(
      await page.inputValue('#setting-url'),
      'https://4router.ai/v1',
    );
    await page.click('#refresh-models');
    await page
      .getByText('已获取 5 个 GPT-6.1 / GPT-6 模型。', { exact: true })
      .waitFor();
    await page.selectOption('#setting-model', 'gpt-6-astra');
    await page.selectOption('#setting-effort', 'high');
    await page.click('#test-connection');
    await page.getByText('连接正常，当前模型可用。', { exact: true }).waitFor();
    assert.equal(await page.locator('#effort-label').textContent(), '思考：高');
    await page.locator('#settings').evaluate((n) => {
      n.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(out, 'profiles.png'),
      fullPage: true,
    });
    await page.click('#profile-new');
    await page.fill('#setting-name', '我的备用中转');
    await page.fill('#setting-url', 'https://backup.example/v1');
    await page.fill('#setting-key', 'SYNTHETIC_TEST_KEY');
    await page.selectOption('#setting-model', 'gpt-6-sol');
    await page.locator('#settings-form button[type=submit]').click();
    await page.waitForSelector('#settings:not([open])', { state: 'attached' });
    assert.equal(
      await page.locator('#profile-switch').inputValue(),
      'custom-1',
    );
    assert.equal(await page.locator('#model-label').inputValue(), 'gpt-6-sol');
    await page.click('#settings-open');
    await page.selectOption('#setting-profile', '4router-core');
    assert.equal(await page.inputValue('#setting-key'), '');
    assert.equal(await page.inputValue('#setting-model'), 'gpt-6-astra');
    await page.locator('#settings-form button[type=submit]').click();
    await page.click('#settings-open');
    await page.selectOption('#setting-profile', 'custom-1');
    await page.click('#profile-delete');
    assert.equal(await page.locator('#profile-switch option').count(), 2);
    assert.equal(await page.locator('#cli-current').textContent(), 'v0.166.0');
    assert.equal(await page.locator('#cli-update').isDisabled(), true);
    await page.locator('.advanced-settings summary').click();
    await page.click('#cli-check');
    assert.equal(
      await page.locator('#cli-update').textContent(),
      '更新至 0.167.0',
    );
    await page.click('#cli-update');
    await page.getByText('v0.167.0', { exact: true }).waitFor();
    assert.equal(await page.locator('#cli-rollback').isDisabled(), false);
    await page.screenshot({
      path: path.join(out, 'updates.png'),
      fullPage: true,
    });
    await page.click('#cli-rollback');
    await page.getByText('v0.166.0', { exact: true }).waitFor();
    await page.click('#settings-close');
    // A model response must never be able to run renderer script.
    await page.evaluate(() => {
      const id = window.testState.sent[0].id;
      const c = window.testState.chats.get(id);
      c.messages.push({
        id: 'malicious',
        role: 'assistant',
        text: '<img src=x onerror="window.XSS=1"><script>window.XSS=2</script>[bad](javascript:alert(1))',
      });
      window.testState.emit({ type: 'chat', chat: c });
    });
    assert.equal(await page.evaluate(() => window.XSS), undefined);
    assert.equal(
      await page.locator('.markdown script,.markdown img').count(),
      0,
    );
    // A partial text event interrupted by a full snapshot must not disable later streaming.
    await page.evaluate(() => {
      const id = window.testState.sent[0].id;
      window.testState.emit({
        type: 'delta',
        chatId: id,
        itemId: 'stream-one',
        delta: '第一段',
      });
      window.testState.emit({
        type: 'chat',
        chat: window.testState.chats.get(id),
      });
      window.testState.emit({
        type: 'delta',
        chatId: id,
        itemId: 'stream-two',
        delta: '后续流式消息',
      });
    });
    await page.getByText('后续流式消息', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      checks: [
        'welcome',
        'desktop pet settings',
        'model dropdown',
        'relay benchmark and use fastest',
        'profile switch',
        'profile create/edit/delete',
        'refresh model catalog',
        'attach before directory selection',
        'pathless clipboard image and thumbnail',
        'plain-text paste preserved',
        'send pasted image',
        'output link',
        'history switch',
        '@ file picker',
        'file drop',
        'settings and connection test',
        'CLI check/update/rollback',
        'renderer sanitization',
      ],
      viewport: '1220x820',
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('UI SMOKE PASSED');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
