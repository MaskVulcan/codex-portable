'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-output/usability-ui');
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
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let callback = () => {};
      const drafts = new Map(),
        profile = {
          id: 'a',
          name: 'axhan',
          model: 'gpt-6.1-sol',
          reasoningEffort: 'xhigh',
          fastMode: true,
          hasApiKey: true,
          webSearch: true,
          models: ['gpt-6.1-sol'],
        };
      const settings = {
        ...profile,
        profiles: [profile, { ...profile, id: 'b', name: '4router' }],
        activeProfileId: 'a',
      };
      const chats = [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
          title: '任务A',
          directory: 'C:\\工作',
          messages: [],
          activity: [],
          busy: false,
          updatedAt: 2,
          tasks: [],
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          title: '任务B',
          directory: 'C:\\工作',
          messages: [],
          activity: [],
          busy: false,
          updatedAt: 1,
          tasks: [],
        },
      ];
      const archive = [];
      const copy = (x) => structuredClone(x);
      window.regression = {
        chats,
        archive,
        drafts,
        emit: (e) => callback(copy(e)),
      };
      window.portable = {
        onEvent: (fn) => (callback = fn),
        initialize: async () => ({
          settings,
          chats: copy(chats),
          dataDirectory: 'C:\\助手\\data',
          cli: { currentVersion: '0.166.0' },
          pet: { settings: {} },
          onboarding: false,
        }),
        getChat: async (id) => copy(chats.find((c) => c.id === id)),
        listChats: async () => copy(chats),
        getDraft: async (id) =>
          copy(drafts.get(id) || { text: '', attachments: [] }),
        saveDraft: async (id, d) => {
          drafts.set(id, copy(d));
          return copy(d);
        },
        selectFiles: async () => [
          { name: 'A材料.docx', path: 'C:\\材料.docx', size: 100 },
        ],
        describeFiles: async (f) =>
          f.map((x) =>
            typeof x === 'string'
              ? { path: x, name: 'A材料.docx', size: 100 }
              : x,
          ),
        listFiles: async () => [],
        outputFiles: async () => [],
        answer: async (id, answers) => {
          window.regression.lastAnswer = { id, answers };
          const c = chats.find((c) =>
            c.pendingQuestions?.some((q) => q.requestId === id),
          );
          c.pendingQuestions = [];
          callback({ type: 'chat', chat: copy(c) });
          return true;
        },
        listArchived: async () => copy(archive),
        restoreChat: async (id) => {
          const index = archive.findIndex((c) => c.id === id),
            c = archive.splice(index, 1)[0];
          chats.push(c);
          return copy(c);
        },
        preferences: async () => ({}),
        backupData: async () => null,
        importData: async () => null,
        diagnostics: async () => null,
        open: async () => true,
        saveResult: async () => null,
        zipResults: async () => null,
        restoreOriginal: async () => null,
        browserStatus: async () => ({
          connected: true,
          pairUrl: 'ws://127.0.0.1:39271/browser?token=' + 'a'.repeat(64),
        }),
        browserExtensionFolder: async () => true,
        browserFocus: async () => true,
        browserResume: async () => true,
      };
    });
    await page.goto(pathToFileURL(path.join(root, 'src/ui/index.html')).href);
    await page.locator('.history-item').filter({ hasText: '任务A' }).click();
    await page.fill('#prompt', 'A的草稿');
    await page.click('#attach');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    await page.locator('.history-item').filter({ hasText: '任务B' }).click();
    assert.equal(await page.inputValue('#prompt'), '');
    assert.equal(await page.locator('.attachment-chip').count(), 0);
    await page.fill('#prompt', 'B的草稿');
    await page.locator('.history-item').filter({ hasText: '任务A' }).click();
    assert.equal(await page.inputValue('#prompt'), 'A的草稿');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    await page.locator('.history-item').filter({ hasText: '任务B' }).click();
    await page.evaluate(() => {
      const c = window.regression.chats[0];
      c.pendingQuestions = [
        {
          requestId: 88,
          questions: [
            {
              id: 'format',
              question: 'A任务需要哪种输出格式？',
              options: [{ label: 'Word' }, { label: 'PDF' }],
            },
          ],
        },
      ];
      window.regression.emit({
        type: 'question',
        chatId: c.id,
        ...c.pendingQuestions[0],
      });
    });
    assert.equal(await page.locator('#question-panel').isVisible(), false);
    await page.locator('.history-item').filter({ hasText: '任务A' }).click();
    await page.getByText('A任务需要哪种输出格式？', { exact: true }).waitFor();
    await page.locator('.history-item').filter({ hasText: '任务B' }).click();
    assert.equal(await page.locator('#question-panel').isVisible(), false);
    assert.equal(await page.inputValue('#prompt'), 'B的草稿');
    await page.locator('.history-item').filter({ hasText: '任务A' }).click();
    await page
      .locator('#question-panel button')
      .filter({ hasText: 'Word' })
      .click();
    await page
      .locator('#question-panel button')
      .filter({ hasText: '继续处理' })
      .click();
    await page.locator('#question-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(
      await page.evaluate(() => window.regression.lastAnswer.answers),
      { format: { answers: ['Word'] } },
    );
    await page.reload();
    await page.locator('.history-item').filter({ hasText: '任务A' }).click();
    // Reload gets a fresh mock backend, so restore persisted-draft behavior is
    // covered in WorkspaceState tests; this page verifies the cross-chat UI path.
    await page.evaluate(() => {
      const c = window.regression.chats[0];
      c.messages = [{ id: 'answer', role: 'assistant', text: '已生成文件。' }];
      c.tasks = [
        {
          id: 'task-1',
          title: '整理报告',
          status: 'completed',
          artifacts: [
            {
              name: '报告.docx',
              path: 'C:/输出/报告.docx',
              size: 100,
              validation: { valid: true, checked: '文件结构' },
            },
          ],
          originals: [{ name: '原文.docx' }],
        },
      ];
      window.regression.emit({ type: 'chat', chat: c });
    });
    await page.getByText('本次生成 1 个文件', { exact: true }).waitFor();
    assert.equal(await page.getByText('另存为', { exact: true }).count(), 1);
    assert.equal(
      await page.getByText('打包本次文件', { exact: true }).count(),
      1,
    );
    await page.evaluate(() => {
      const c = window.regression.chats[0];
      c.busy = true;
      c.status = '正在采集浏览器内容';
      c.tasks[0].startedAt = Date.now() - 7000;
      c.tasks[0].progress = {
        updatedAt: Date.now(),
        detail: '正在读取通勤穿搭笔记 3/20',
        errors: 1,
        lastError: '页面需要登录',
        plan: [
          { step: '搜索主题相关帖子', status: 'completed' },
          { step: '读取 5 屏评论并截图', status: 'in_progress' },
        ],
      };
      c.tasks[0].collection = {
        status: 'running',
        detail: '已保留 3 篇的截图',
        completed: 3,
        total: 20,
        comments: 41,
        screenshots: 18,
        failed: 1,
      };
      window.regression.emit({ type: 'chat', chat: c });
    });
    assert.match(
      await page.locator('#progress-headline').textContent(),
      /采集浏览器内容/,
    );
    assert.match(
      await page.locator('#progress-counts').textContent(),
      /3 \/ 20 篇/,
    );
    assert.match(
      await page.locator('#progress-warning').textContent(),
      /1 次工具错误/,
    );
    assert.match(
      await page.locator('#progress-plan').textContent(),
      /搜索主题相关帖子/,
    );
    assert.equal(await page.locator('#progress-resume').isVisible(), false);
    await page.evaluate(() => {
      const c = window.regression.chats[0];
      c.busy = false;
      c.status = '部分完成';
      c.tasks[0].collection.status = 'needs_user';
      window.regression.emit({ type: 'chat', chat: c });
    });
    await page.locator('#progress-resume').click();
    await page.click('#browser-open');
    await page.getByText('连接用户浏览器', { exact: true }).waitFor();
    assert.match(
      await page.locator('#browser-connection-status').textContent(),
      /已连接/,
    );
    await page.click('#browser-close');
    await page.screenshot({
      path: path.join(out, 'result-card.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      const c = window.regression.chats.splice(1, 1)[0];
      window.regression.archive.push(c);
    });
    await page.selectOption('#history-mode', 'archived');
    await page.locator('.history-item').filter({ hasText: '任务B' }).click();
    assert.equal(await page.locator('#history-mode').inputValue(), 'active');
    assert.equal(await page.inputValue('#prompt'), '');
    await page.click('#help-open');
    await page.getByText('备份历史与配置', { exact: true }).waitFor();
    await page.click('#help-close');
    assert.deepEqual(errors, []);
    const quick = await browser.newPage({
      viewport: { width: 440, height: 540 },
    });
    await quick.addInitScript(() => {
      let callback;
      const active = {
        id: 'a',
        title: 'A',
        directory: 'C:\\工作',
        messages: [{ role: 'assistant', text: '上一段内容' }],
        draft: { text: '', attachments: [] },
      };
      window.regression = {
        emit: (s) => callback({ type: 'state', state: s }),
      };
      window.companion = {
        onEvent: (fn) => (callback = fn),
        init: async () => ({
          state: {
            active,
            chats: [],
            notices: [],
            profile: {},
            message: '待机',
          },
        }),
        takeFiles: async () => [],
        draft: async () => ({}),
      };
    });
    await quick.goto(pathToFileURL(path.join(root, 'src/pet/quick.html')).href);
    await quick.getByText('上一段内容', { exact: true }).waitFor();
    await quick.evaluate(() =>
      window.regression.emit({
        active: {
          id: 'b',
          title: 'B',
          directory: 'C:\\工作',
          messages: [],
          draft: { text: 'B草稿', attachments: [] },
        },
        chats: [],
        notices: [],
        profile: {},
        message: '待机',
      }),
    );
    assert.equal(
      await quick.getByText('上一段内容', { exact: true }).count(),
      0,
    );
    assert.equal(await quick.inputValue('#prompt'), 'B草稿');
    const report = {
      passed: true,
      browserProgressVisible: true,
      browserPairingGuideVisible: true,
      browserResumeVisible: true,
      draftsIsolatedAcrossChats: true,
      attachmentsRestored: true,
      pendingQuestionRecovered: true,
      questionNeverShownInWrongChat: true,
      quickEmptyStateClearsOldContent: true,
      taskResultActionsVisible: true,
      archiveRestoreVisible: true,
      helpAndBackupEntry: true,
      platform: process.platform,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('USABILITY UI REGRESSION PASSED');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
