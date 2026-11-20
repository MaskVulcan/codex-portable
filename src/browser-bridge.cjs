'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { readJson, atomicJson } = require('./persistence.cjs');
const { abortable, cancelled } = require('./workflow.cjs');
class BrowserBridge {
  constructor({ root, onCall, onChange = () => {}, port = 39271 }) {
    Object.assign(this, { root, onCall, onChange, preferredPort: port });
    this.file = path.join(root, 'browser-connection.json');
    const saved = readJson(this.file, {});
    this.token = /^[a-f0-9]{64}$/.test(saved.token || '')
      ? saved.token
      : crypto.randomBytes(32).toString('hex');
    this.pending = new Map();
    this.sequence = 0;
    this.client = null;
    this.server = null;
    this.starting = null;
  }
  status() {
    return {
      connected: this.client?.readyState === WebSocket.OPEN,
      port: this.port || null,
    };
  }
  authorized(token) {
    const a = Buffer.from(token || ''),
      b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  async start() {
    if (this.server) return this.file;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async _start() {
    const server = http.createServer((req, res) => this.http(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 20 * 1024 * 1024,
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      // Only extensions may connect from a browser; ordinary website origins cannot.
      if (
        url.pathname !== '/browser' ||
        !this.authorized(url.searchParams.get('token')) ||
        (req.headers.origin &&
          !/^chrome-extension:\/\/[a-z]{32}$/.test(req.headers.origin))
      ) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (client) => {
        this.client?.close(1000, 'Replaced');
        this.client = client;
        client.on('message', (raw) => {
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            return;
          }
          if (value.type === 'ping') {
            client.send('{"type":"pong"}');
            return;
          }
          const pending = this.pending.get(value.id);
          if (!pending) return;
          this.pending.delete(value.id);
          clearTimeout(pending.timer);
          value.error
            ? pending.reject(new Error(value.error))
            : pending.resolve(value.result);
        });
        client.on('close', () => {
          if (this.client === client) {
            this.client = null;
            this.rejectPending(
              '浏览器扩展已断开，请重新连接后继续；已保存内容和断点保留。',
            );
            this.onChange(this.status());
          }
        });
        client.on('error', () => {});
        this.onChange(this.status());
      });
    });
    for (let offset = 0; offset < 10; offset++) {
      try {
        await new Promise((resolve, reject) => {
          const fail = (e) => {
            server.off('listening', ready);
            reject(e);
          };
          const ready = () => {
            server.off('error', fail);
            resolve();
          };
          server.once('error', fail);
          server.once('listening', ready);
          server.listen(
            this.preferredPort ? this.preferredPort + offset : 0,
            '127.0.0.1',
          );
        });
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || offset === 9) throw e;
      }
    }
    this.server = server;
    this.port = server.address().port;
    atomicJson(this.file, {
      endpoint: `http://127.0.0.1:${this.port}/call`,
      token: this.token,
    });
    return this.file;
  }
  pairUrl() {
    return `ws://127.0.0.1:${this.port}/browser?token=${this.token}`;
  }
  async http(req, res) {
    const reply = (code, value) => {
      if (!res.writableEnded) {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(value));
      }
    };
    if (
      req.method !== 'POST' ||
      req.url !== '/call' ||
      req.headers.origin ||
      !this.authorized(
        (req.headers.authorization || '').replace(/^Bearer /, ''),
      )
    ) {
      reply(403, { error: 'Forbidden' });
      req.resume();
      return;
    }
    let body = '';
    req.setTimeout(180000);
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) {
          reply(413, { error: 'Request too large' });
          return;
        }
      }
      const args = JSON.parse(body);
      reply(200, { result: await this.onCall(args) });
    } catch (error) {
      reply(200, { error: error.message });
    }
  }
  async request(session, op, args = {}, signal) {
    signal?.throwIfAborted();
    if (!this.status().connected)
      throw new Error(
        '尚未连接浏览器扩展。请打开左侧“浏览器采集”完成配对，不要安装 Playwright 或反复重试。',
      );
    const id = ++this.sequence;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            '浏览器操作超过 25 秒，已停止等待；请查看页面是否需要登录或验证。',
          ),
        );
        this.client?.send(JSON.stringify({ type: 'cancel', id }));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(JSON.stringify({ id, session, op, args }));
    });
    try {
      return await abortable(result, signal);
    } finally {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(cancelled());
        if (this.status().connected)
          this.client.send(JSON.stringify({ type: 'cancel', id }));
      }
    }
  }
  rejectPending(message) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  close() {
    this.rejectPending('浏览器连接已关闭。');
    this.client?.terminate();
    this.client = null;
    this.wss?.close();
    this.server?.close();
    this.server = null;
  }
}
module.exports = { BrowserBridge };
