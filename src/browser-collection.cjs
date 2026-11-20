'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { atomicJson, readJson } = require('./persistence.cjs');
const { cancelled } = require('./workflow.cjs');
function noteKey(value) {
  const u = new URL(value);
  if (
    !['https:', 'http:'].includes(u.protocol) ||
    !/(^|\.)xiaohongshu\.com$/i.test(u.hostname) ||
    !/^\/(?:explore|discovery\/item)\/[a-zA-Z0-9]+/.test(u.pathname)
  )
    throw new Error(
      '批量采集需要完整的小红书笔记链接，先搜索主题并收集结果页里的链接。短链接请先打开解析。',
    );
  return /\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/.exec(u.pathname)[1];
}
function csv(value) {
  const s = String(value ?? '');
  return '"' + (/^[=+@-]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
}
class BrowserCollector {
  constructor({ bridge, onProgress = () => {} }) {
    Object.assign(this, { bridge, onProgress });
    this.running = new Set();
  }
  update(task, state, detail) {
    const values = Object.values(state.notes);
    task.collection = {
      status: state.status,
      total: state.queue.length,
      completed: values.filter((n) => n.status === 'collected').length,
      failed: values.filter((n) => n.status === 'failed').length,
      comments: values.reduce((n, v) => n + (v.comments?.length || 0), 0),
      screenshots: values.reduce((n, v) => n + (v.screenshots?.length || 0), 0),
      currentUrl: state.currentUrl || '',
      detail,
      checkpoint: path.join(task.output, '.work', 'browser-collection.json'),
      updatedAt: Date.now(),
    };
    const publicDir = path.join(task.output, '小红书采集');
    fs.mkdirSync(publicDir, { recursive: true });
    atomicJson(task.collection.checkpoint, state);
    atomicJson(path.join(publicDir, '采集记录.json'), {
      topic: task.title,
      status: state.status,
      scope:
        '仅浏览器实际加载的正文、评论与截图；不保证全部评论，不自动展开所有楼中楼。',
      notes: values,
      updatedAt: new Date().toISOString(),
    });
    const rows = [
      ['笔记链接', '标题', '状态', '已加载评论数', '范围', '截图文件', '错误'],
      ...values.map((n) => [
        n.url,
        n.title,
        n.status,
        n.comments?.length || 0,
        n.scope,
        (n.screenshots || []).join('\n'),
        n.error || '',
      ]),
    ];
    fs.writeFileSync(
      path.join(publicDir, '采集索引.csv'),
      '\ufeff' + rows.map((r) => r.map(csv).join(',')).join('\r\n'),
      'utf8',
    );
    this.onProgress(task, detail);
  }
  async screenshot(session, dir, name, signal) {
    const result = await this.bridge.request(session, 'screenshot', {}, signal);
    signal?.throwIfAborted();
    const data = Buffer.from(result?.data || '', 'base64');
    if (
      data.length < 24 ||
      data.length > 15 * 1024 * 1024 ||
      data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      throw new Error('浏览器未返回有效 PNG 截图。');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, data);
    return file;
  }
  async collect({ task, session, urls = [], commentPages = 5, signal }) {
    if (this.running.has(session))
      throw new Error('当前对话已有采集正在进行。');
    if (!Array.isArray(urls) || urls.length > 10)
      throw new Error('每批最多采集 10 篇，分批续采可保留全部进度。');
    const incoming = urls.map((url) => ({ id: noteKey(url), url }));
    const checkpoint = path.join(
      task.output,
      '.work',
      'browser-collection.json',
    );
    const state = readJson(checkpoint, { queue: [], notes: {} });
    state.notes ||= {};
    state.queue ||= [];
    for (const item of incoming)
      if (!state.queue.some((q) => q.id === item.id)) state.queue.push(item);
      else {
        const existing = state.queue.find((q) => q.id === item.id);
        existing.url = item.url;
      }
    if (state.queue.length > 500)
      throw new Error('一个专题最多保留 500 篇笔记，请按主题拆分。');
    if (
      !Number.isInteger(commentPages) ||
      commentPages < 1 ||
      commentPages > 20
    )
      throw new Error('单篇评论截图范围应在 1 到 20 屏之间。');
    state.commentPages = commentPages;
    state.status = 'running';
    this.running.add(session);
    const until = Date.now() + 110000;
    let processed = 0;
    try {
      for (const item of state.queue) {
        signal?.throwIfAborted();
        const previous = state.notes[item.id];
        if (
          previous?.status === 'collected' &&
          (previous.reachedEnd ||
            (previous.nextScreen ?? commentPages) >= commentPages)
        )
          continue;
        if (processed >= 10 || Date.now() > until) {
          state.status = 'paused';
          this.update(task, state, '本批已保存，可继续下一批。');
          break;
        }
        state.currentUrl = item.url;
        const note = (Object.hasOwn(state.notes, item.id)
          ? state.notes[item.id]
          : null) || {
          url: item.url,
          comments: [],
          screenshots: [],
          status: 'pending',
        };
        note.url = item.url;
        state.notes[item.id] = note;
        note.status = 'reading';
        delete note.error;
        this.update(
          task,
          state,
          '正在打开第 ' +
            (state.queue.indexOf(item) + 1) +
            ' / ' +
            state.queue.length +
            ' 篇笔记',
        );
        try {
          let page = await this.bridge.request(
            session,
            'open',
            { url: item.url },
            signal,
          );
          const folder = path.join(
            task.output,
            '小红书采集',
            '笔记-' + item.id,
          );
          const seen = new Set(note.comments.map((c) => c.id || c.text));
          let startScreen = Math.min(note.nextScreen || 0, commentPages - 1);
          if (startScreen && !page.gate) {
            page = await this.bridge.request(
              session,
              'scroll',
              { position: note.lastPosition || 0 },
              signal,
            );
            if (!page.gate)
              page = await this.bridge.request(
                session,
                'scroll',
                { direction: 'down' },
                signal,
              );
          }
          // Resume after the last saved screen; do not repeatedly capture the top.
          for (let screen = startScreen; screen < commentPages; screen++) {
            signal?.throwIfAborted();
            if (page.gate) {
              note.status = 'paused';
              state.status = 'needs_user';
              note.error =
                page.gate === 'rate_limit'
                  ? '网站提示访问频繁，请稍后再继续。'
                  : '请在浏览器完成登录或验证，再点“继续采集”。';
              this.update(task, state, note.error);
              return { ...task.collection, needsUser: true };
            }
            note.title = page.heading || page.title;
            note.content = page.content;
            note.finalUrl = page.url;
            for (const c of page.comments || []) {
              const key = c.id || c.text;
              if (!seen.has(key)) {
                seen.add(key);
                note.comments.push(c);
              }
            }
            const image = await this.screenshot(
              session,
              folder,
              screen === 0
                ? '帖子及首屏'
                : '评论-' + String(screen).padStart(2, '0'),
              signal,
            );
            if (!note.screenshots.includes(image)) note.screenshots.push(image);
            note.nextScreen = screen + 1;
            note.lastPosition = page.position || 0;
            note.scope = `已查看 ${screen + 1} 屏；仅保存实际加载评论，未保证全部楼中楼`;
            this.update(
              task,
              state,
              `第 ${state.queue.indexOf(item) + 1} / ${state.queue.length} 篇 · 已保存 ${note.comments.length} 条评论、${note.screenshots.length} 张截图`,
            );
            if (page.endVisible) {
              note.reachedEnd = true;
              note.scope += '；页面显示到底';
              break;
            }
            if (screen === commentPages - 1) break;
            if (Date.now() > until) {
              state.status = 'paused';
              note.status = 'paused';
              this.update(
                task,
                state,
                '达到本批时限，当前笔记已保存，可继续采集。',
              );
              return task.collection;
            }
            const moved = await this.bridge.request(
              session,
              'scroll',
              { direction: 'down' },
              signal,
            );
            page = moved;
            if (!moved.acted?.moved) {
              note.reachedEnd = true;
              note.scope += '；当前区域无法继续滚动';
              break;
            }
          }
          note.status = 'collected';
          processed++;
          this.update(task, state, '已保存本篇帖子、评论和截图');
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          note.status = 'failed';
          note.error = error.message;
          // A broken connection or a failed operation must not trigger a long retry loop.
          state.status = 'paused';
          this.update(
            task,
            state,
            '本篇遇到问题，已保留断点：' + error.message,
          );
          return task.collection;
        }
      }
      if (
        state.queue.every(
          (item) => state.notes[item.id]?.status === 'collected',
        )
      )
        state.status = 'completed';
      this.update(
        task,
        state,
        state.status === 'completed'
          ? '本批链接已处理；评论范围见采集索引。'
          : '本批已保存，可继续采集。',
      );
      return {
        ...task.collection,
        index: path.join(task.output, '小红书采集', '采集索引.csv'),
      };
    } catch (error) {
      state.status = signal?.aborted ? 'stopped' : 'paused';
      this.update(
        task,
        state,
        signal?.aborted ? '采集已停止，断点和已保存文件保留。' : error.message,
      );
      throw error;
    } finally {
      this.running.delete(session);
    }
  }
}
module.exports = { BrowserCollector, noteKey, csv };
