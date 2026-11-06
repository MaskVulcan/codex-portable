'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Windows read-only attributes and short antivirus/backup locks are common in
// portable folders. Never remove the last valid copy before a new save succeeds.
function createJsonStorage({
  io = fs,
  pause = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const transient = (e) => ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code);
  function writable(filename) {
    try {
      io.chmodSync(filename, 0o600);
    } catch (e) {
      if (e.code !== 'ENOENT' && !transient(e)) throw e;
    }
  }
  function retry(operation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return operation();
      } catch (e) {
        if (!transient(e) || attempt >= 4) throw e;
        pause([15, 30, 50, 80][attempt]);
      }
    }
  }
  function pendingFiles(filename) {
    const dir = path.dirname(filename),
      base = path.basename(filename);
    try {
      return io
        .readdirSync(dir)
        .filter((n) => n === base + '.tmp' || n.startsWith(base + '.tmp-'))
        .map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  }
  function durableWrite(filename, text, exclusive = false) {
    if (!exclusive) writable(filename);
    let descriptor;
    try {
      descriptor = retry(() =>
        io.openSync(filename, exclusive ? 'wx' : 'w', 0o600),
      );
      io.writeFileSync(descriptor, text, { encoding: 'utf8' });
      io.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) io.closeSync(descriptor);
    }
  }
  function atomicJson(filename, data) {
    io.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary =
      filename +
      '.tmp-' +
      process.pid +
      '-' +
      crypto.randomBytes(6).toString('hex');
    const text = JSON.stringify(data, null, 2);
    durableWrite(temporary, text, true);
    try {
      // Backup creation is useful but must not make an otherwise writable save fail.
      try {
        const previous = io.readFileSync(filename, 'utf8');
        JSON.parse(previous);
        writable(filename + '.bak');
        retry(() => io.copyFileSync(filename, filename + '.bak'));
        writable(filename + '.bak');
      } catch {}
      writable(filename);
      try {
        retry(() => io.renameSync(temporary, filename));
      } catch (e) {
        if (!transient(e)) throw e;
        // Some Windows readers share write access but deny replacement. The
        // complete temporary copy stays available until this fallback is durable.
        durableWrite(filename, text);
        writable(temporary);
        io.rmSync(temporary, { force: true });
      }
      writable(filename);
      for (const stale of pendingFiles(filename)) {
        try {
          writable(stale);
          io.rmSync(stale, { force: true });
        } catch {}
      }
    } catch (error) {
      // Keep the new temporary JSON for automatic recovery on the next launch.
      error.message =
        '无法保存本地数据，请稍后重试；新内容已保留为恢复文件。 ' +
        error.message;
      throw error;
    }
  }
  function readJson(filename, fallback) {
    let currentTime = -1;
    try {
      currentTime = io.statSync(filename).mtimeMs;
    } catch {}
    const pending = pendingFiles(filename)
      .map((file) => {
        try {
          return { file, time: io.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time);
    const newer = pending
      .filter((p) => p.time >= currentTime)
      .map((p) => p.file);
    const candidates = [
      ...newer,
      filename,
      ...pending.filter((p) => p.time < currentTime).map((p) => p.file),
      filename + '.bak',
    ];
    for (const candidate of [...new Set(candidates)]) {
      try {
        return JSON.parse(io.readFileSync(candidate, 'utf8'));
      } catch (e) {
        if (candidate === filename && e instanceof SyntaxError) {
          // A failed recovery copy must never turn a recoverable read into a crash.
          try {
            io.copyFileSync(filename, filename + '.recovery-' + Date.now());
          } catch {}
        }
      }
    }
    return fallback;
  }
  return { atomicJson, readJson };
}
module.exports = { createJsonStorage, ...createJsonStorage() };
