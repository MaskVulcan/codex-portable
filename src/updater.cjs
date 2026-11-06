'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const tar = require('tar');
const { atomicJson, readJson, CodexRpc } = require('./core.cjs');

const ASSET = 'codex-package-x86_64-pc-windows-msvc.tar.gz';
const TARGET = 'x86_64-pc-windows-msvc';
const RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
function compare(a, b) {
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++)
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function descriptor(value) {
  if (
    !value ||
    !SEMVER.test(value.version) ||
    !/^codex$|^cli-versions\/[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$/.test(
      value.directory,
    )
  )
    throw new Error('CLI 版本记录损坏，已停止切换。');
  return { version: value.version, directory: value.directory };
}
function safeUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.port ||
    u.username ||
    u.password ||
    ![
      'api.github.com',
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ].includes(u.hostname)
  )
    throw new Error('更新地址不属于官方发布服务。');
  return u;
}
function selectRelease(release) {
  const version = /^rust-v(\d+\.\d+\.\d+)$/.exec(release.tag_name || '')?.[1];
  if (!version || !SEMVER.test(version) || release.draft || release.prerelease)
    throw new Error('官方发布信息不包含有效的稳定版本。');
  const asset = release.assets?.find((a) => a.name === ASSET);
  if (
    !asset ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1024 ||
    asset.size > MAX_ARCHIVE
  )
    throw new Error('找不到 Windows 64 位完整 CLI 运行包。');
  const expected = `https://github.com/openai/codex/releases/download/rust-v${version}/${ASSET}`;
  if (asset.browser_download_url !== expected)
    throw new Error('CLI 下载地址与官方版本不匹配。');
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1];
  if (!digest) throw new Error('官方未提供 SHA-256 校验值，本次更新未开始。');
  return {
    version,
    url: expected,
    size: asset.size,
    sha256: digest.toLowerCase(),
  };
}
async function request(url, { signal, redirects = 0, transport } = {}) {
  if (transport) {
    const u = safeUrl(url),
      response = await transport(u.href, {
        headers: {
          'User-Agent':
            'Codex-Portable-Updater/' + require('../package.json').version,
          Accept: 'application/vnd.github+json',
        },
        redirect: 'manual',
        signal,
      });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects >= 5) throw new Error('官方下载重定向次数过多。');
      return request(new URL(response.headers.get('location'), u).href, {
        signal,
        redirects: redirects + 1,
        transport,
      });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(
        response.status === 403
          ? '官方服务暂时限制请求，请稍后重试。'
          : `官方服务返回 HTTP ${response.status}，请检查网络后重试。`,
      );
    }
    return Readable.fromWeb(response.body);
  }
  return new Promise((resolve, reject) => {
    const u = safeUrl(url);
    const req = https.get(
      u,
      {
        headers: {
          'User-Agent':
            'Codex-Portable-Updater/' + require('../package.json').version,
          Accept: 'application/vnd.github+json',
        },
        signal,
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error('官方下载重定向次数过多。'));
            return;
          }
          try {
            resolve(
              request(new URL(response.headers.location, u).href, {
                signal,
                redirects: redirects + 1,
              }),
            );
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              response.statusCode === 403
                ? '官方服务暂时限制请求，请稍后重试。'
                : `官方服务返回 HTTP ${response.statusCode}，请检查网络后重试。`,
            ),
          );
          return;
        }
        response.setTimeout(60000, () =>
          response.destroy(new Error('下载长时间没有响应，请重试。')),
        );
        resolve(response);
      },
    );
    req.setTimeout(30000, () =>
      req.destroy(new Error('连接官方更新服务超时。')),
    );
    req.on('error', reject);
  });
}
async function releaseInfo({ signal, transport } = {}) {
  const response = await request(RELEASE_URL, { signal, transport });
  let bytes = 0,
    chunks = [];
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      response.destroy();
      throw new Error('官方版本信息过大。');
    }
    chunks.push(chunk);
  }
  return selectRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
async function verifiedDownload(
  response,
  release,
  file,
  { signal, progress = () => {} } = {},
) {
  let bytes = 0,
    last = 0;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > release.size || bytes > MAX_ARCHIVE) {
        done(new Error('下载包大小与官方信息不符。'));
        return;
      }
      hash.update(chunk);
      if (Date.now() - last > 200) {
        last = Date.now();
        progress(bytes, release.size);
      }
      done(null, chunk);
    },
  });
  await pipeline(response, meter, fs.createWriteStream(file, { flags: 'wx' }), {
    signal,
  });
  if (bytes !== release.size || hash.digest('hex') !== release.sha256)
    throw new Error('下载文件校验失败，旧版 CLI 已保留。');
  progress(bytes, release.size);
}
async function downloadPackage(
  release,
  file,
  { signal, progress = () => {}, transport } = {},
) {
  const response = await request(release.url, { signal, transport });
  await verifiedDownload(response, release, file, { signal, progress });
}
function safeEntry(entry) {
  const name = entry.path.replace(/\\/g, '/');
  if (
    !['File', 'OldFile', 'Directory'].includes(entry.type) ||
    name.length > 300 ||
    name.startsWith('/') ||
    name.includes(':') ||
    name.includes('\0')
  )
    return false;
  const parts = name.split('/').filter((p) => p && p !== '.');
  return (
    parts.length > 0 &&
    !parts.some(
      (p) =>
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  );
}
async function extractPackage(file, directory, { signal } = {}) {
  const invalid = [];
  let total = 0,
    count = 0;
  await tar.x({
    file,
    cwd: directory,
    strict: true,
    preservePaths: false,
    filter: (_name, entry) => {
      if (signal?.aborted) {
        invalid.push('cancelled');
        return false;
      }
      total += entry.size || 0;
      count++;
      const okay =
        safeEntry(entry) && total <= 2 * 1024 * 1024 * 1024 && count <= 15000;
      if (!okay) invalid.push('invalid');
      return okay;
    },
  });
  signal?.throwIfAborted();
  if (invalid.length)
    throw new Error('更新包包含不支持的路径或文件类型，已保留旧版。');
}
async function validatePackage(directory, version) {
  const info = JSON.parse(
    await fs.promises.readFile(
      path.join(directory, 'codex-package.json'),
      'utf8',
    ),
  );
  if (
    info.version !== version ||
    info.target !== TARGET ||
    info.layoutVersion !== 1 ||
    info.entrypoint !== 'bin/codex.exe' ||
    info.variant !== 'codex'
  )
    throw new Error('CLI 包版本、架构或目录格式不匹配。');
  for (const name of [
    'bin/codex.exe',
    'bin/codex-exec-server.exe',
    'bin/codex-code-mode-host.exe',
    'codex-path/rg.exe',
  ]) {
    const handle = await fs.promises.open(path.join(directory, name), 'r');
    try {
      const head = Buffer.alloc(64);
      await handle.read(head, 0, 64, 0);
      if (head.toString('ascii', 0, 2) !== 'MZ')
        throw new Error('CLI 运行文件格式无效。');
      const offset = head.readUInt32LE(0x3c),
        size = (await handle.stat()).size;
      if (offset < 64 || offset + 6 > size)
        throw new Error('CLI 运行文件损坏。');
      const pe = Buffer.alloc(6);
      await handle.read(pe, 0, 6, offset);
      if (
        pe.toString('ascii', 0, 4) !== 'PE\0\0' ||
        pe.readUInt16LE(4) !== 0x8664
      )
        throw new Error('CLI 运行文件不是 Windows x64 程序。');
    } finally {
      await handle.close();
    }
  }
}
async function versionOf(executable) {
  return new Promise((resolve, reject) => {
    const p = spawn(executable, ['--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('新版 CLI 启动测试超时。'));
    }, 20000);
    p.stdout.on('data', (b) => {
      output = (output + b.toString()).slice(-2048);
    });
    p.stderr.resume();
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('新版 CLI 无法启动：' + e.message));
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      const v = /codex(?:-cli)?\s+(\d+\.\d+\.\d+)/i.exec(output)?.[1];
      if (code !== 0 || !v) reject(new Error('新版 CLI 启动测试失败。'));
      else resolve(v);
    });
  });
}
async function probeCli({
  directory,
  version,
  home,
  settings,
  executable = path.join(directory, 'bin', 'codex.exe'),
}) {
  if ((await versionOf(executable)) !== version)
    throw new Error('新版 CLI 报告的版本与下载版本不符。');
  const client = new CodexRpc({
    executable,
    home,
    settings,
    env: {
      PATH: [
        path.dirname(executable),
        path.join(directory, 'codex-path'),
        process.env.PATH,
      ].join(path.delimiter),
    },
    log: () => {},
  });
  try {
    await client.start();
  } finally {
    const child = client.process;
    let timer;
    const exited =
      child && child.exitCode === null && child.signalCode === null
        ? new Promise((resolve, reject) => {
            child.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            timer = setTimeout(
              () => reject(new Error('CLI 测试进程未能正常退出，已保留旧版。')),
              12000,
            );
          })
        : Promise.resolve();
    client.close();
    await exited;
  }
}

class CliUpdater {
  constructor({
    root,
    payload,
    bundledDirectory,
    getSettings = () => ({}),
    beforeSwitch = async () => {},
    afterSwitch = async () => {},
    onProgress = () => {},
    transport,
    fetchRelease = (opts) => releaseInfo({ ...opts, transport }),
    download = (release, file, opts) =>
      downloadPackage(release, file, { ...opts, transport }),
    extract = extractPackage,
    probe = probeCli,
  }) {
    Object.assign(this, {
      root,
      payload,
      getSettings,
      beforeSwitch,
      afterSwitch,
      onProgress,
      fetchRelease,
      download,
      extract,
      probe,
    });
    this.runtime = path.join(root, 'runtime');
    this.work = path.join(root, 'updates');
    this.filename = path.join(this.runtime, '.cli-state.json');
    this.bundledDirectory =
      bundledDirectory || path.join(this.runtime, 'codex');
    const manifest = readJson(path.join(payload, 'manifest.json'), {});
    this.bundledVersion = manifest.codexVersion || '0.166.0';
    const legacy = path.join(this.runtime, 'codex'),
      legacyInfo = readJson(path.join(legacy, 'codex-package.json'), {});
    if (
      bundledDirectory &&
      SEMVER.test(legacyInfo.version || '') &&
      compare(legacyInfo.version, this.bundledVersion) > 0
    )
      this.bundledDirectory = legacy;
    const baseline = readJson(
      path.join(this.bundledDirectory, 'codex-package.json'),
      {},
    );
    this.baseVersion = SEMVER.test(baseline.version || '')
      ? baseline.version
      : this.bundledVersion;
    this.state = readJson(this.filename, {
      active: { version: this.baseVersion, directory: 'codex' },
      previous: null,
    });
    for (const d of [this.state.active, this.state.previous])
      if (d?.directory === 'codex') d.version = this.baseVersion;
    this.state.active = descriptor(this.state.active);
    if (this.state.previous)
      this.state.previous = descriptor(this.state.previous);
    this.busy = false;
    this.latest = null;
    this.phase = 'idle';
    this.message = this.state.message || '';
    this.bytes = 0;
    this.total = 0;
    this.initialized = null;
  }
  absolute(d) {
    const selected = descriptor(d);
    return selected.directory === 'codex'
      ? this.bundledDirectory
      : path.join(this.runtime, selected.directory);
  }
  save() {
    atomicJson(this.filename, this.state);
  }
  status() {
    return {
      currentVersion: this.state.active.version,
      bundledVersion: this.bundledVersion,
      previousVersion: this.state.previous?.version || null,
      latestVersion: this.latest?.version || null,
      updateAvailable:
        !!this.latest &&
        compare(this.latest.version, this.state.active.version) > 0,
      busy: this.busy,
      phase: this.phase,
      message: this.message,
      bytes: this.bytes,
      total: this.total,
    };
  }
  progress(phase, message, extra = {}) {
    Object.assign(this, { phase, message, ...extra });
    this.onProgress(this.status());
  }
  initialize() {
    if (!this.initialized)
      this.initialized = this.recover().catch((e) => {
        this.initialized = null;
        throw e;
      });
    return this.initialized;
  }
  async recover() {
    if (this.state.pending) {
      await this.restoreHome(this.state.pending);
      this.state.active = descriptor(this.state.pending.from);
      this.state.previous = this.state.pending.previous
        ? descriptor(this.state.pending.previous)
        : null;
      delete this.state.pending;
      this.state.message = '上次更新未完成，已恢复原来的 CLI。';
      this.message = this.state.message;
      this.save();
    }
    if (
      this.state.active.directory !== 'codex' &&
      !fs.existsSync(
        path.join(this.absolute(this.state.active), 'bin', 'codex.exe'),
      )
    ) {
      const fallback =
        this.state.previous &&
        fs.existsSync(
          path.join(this.absolute(this.state.previous), 'bin', 'codex.exe'),
        )
          ? this.state.previous
          : { version: this.baseVersion, directory: 'codex' };
      this.state.active = descriptor(fallback);
      this.state.previous = null;
      this.state.message = '更新后的 CLI 文件缺失，已切回可用版本。';
      this.message = this.state.message;
      this.save();
    }
  }
  async executable() {
    await this.initialize();
    return path.join(this.absolute(this.state.active), 'bin', 'codex.exe');
  }
  async locked(fn) {
    if (this.busy) throw new Error('CLI 正在检查或更新，请稍候。');
    this.busy = true;
    this.controller = new AbortController();
    this.bytes = 0;
    this.total = 0;
    const timeout = setTimeout(
      () => this.controller.abort(new Error('更新连接超时，请稍后重试。')),
      15 * 60 * 1000,
    );
    try {
      await this.initialize();
      await fn(this.controller.signal);
    } catch (e) {
      this.progress(
        'error',
        this.controller.signal.aborted
          ? '已取消或连接超时，原 CLI 保持可用。'
          : e.message,
      );
      throw e;
    } finally {
      clearTimeout(timeout);
      this.busy = false;
      this.onProgress(this.status());
    }
    return this.status();
  }
  check() {
    return this.locked(async (signal) => {
      this.progress('checking', '正在检查官方稳定版本…');
      this.latest = await this.fetchRelease({ signal });
      this.progress(
        'idle',
        compare(this.latest.version, this.state.active.version) > 0
          ? `可更新到 ${this.latest.version}`
          : '当前已是最新稳定版本。',
      );
      return this.status();
    });
  }
  cancel() {
    if (
      this.busy &&
      ['checking', 'downloading', 'extracting', 'testing'].includes(this.phase)
    ) {
      this.controller.abort(new Error('更新已取消。'));
      return true;
    }
    return false;
  }
  async snapshot(transaction) {
    const id = path.basename(transaction),
      home = path.join(this.root, 'codex-home');
    const homeExisted = fs.existsSync(home);
    if (homeExisted)
      await fs.promises.cp(home, path.join(transaction, 'native-home'), {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(home, source),
            first = relative.split(path.sep)[0];
          if (
            [
              '.tmp',
              'tmp',
              'cache',
              'plugins',
              'logs',
              'shell_snapshots',
              'app-server-control',
              'app-server-daemon',
            ].includes(first)
          )
            return false;
          return !fs.lstatSync(source).isSymbolicLink();
        },
      });
    return { transaction: id, homeExisted };
  }
  async restoreHome(pending) {
    if (!/^[a-f0-9]{16}$/.test(pending.transaction))
      throw new Error('CLI 恢复记录无效。');
    const transaction = path.join(
        this.work,
        'transactions',
        pending.transaction,
      ),
      home = path.join(this.root, 'codex-home'),
      snapshot = path.join(transaction, 'native-home');
    if (pending.homeExisted && !fs.existsSync(snapshot))
      throw new Error('CLI 恢复备份缺失，请保留 data 目录以便恢复。');
    const failed = path.join(transaction, 'failed-home');
    // Idempotent when a process exits in the middle of recovery.
    if (fs.existsSync(home) && !fs.existsSync(failed))
      await fs.promises.rename(home, failed);
    if (pending.homeExisted) {
      const restored = path.join(transaction, 'restored-home');
      await fs.promises.rm(restored, { recursive: true, force: true });
      await fs.promises.cp(snapshot, restored, { recursive: true });
      if (fs.existsSync(home))
        await fs.promises.rm(home, { recursive: true, force: true });
      await fs.promises.rename(restored, home);
    } else if (fs.existsSync(home))
      await fs.promises.rm(home, { recursive: true, force: true });
  }
  async switchTo(target, message, signal) {
    this.progress('switching', '正在切换 CLI 并验证启动…');
    await this.beforeSwitch();
    signal?.throwIfAborted();
    const previousState = structuredClone(this.state),
      transaction = path.join(
        this.work,
        'transactions',
        crypto.randomBytes(8).toString('hex'),
      );
    await fs.promises.mkdir(transaction, { recursive: true });
    const backup = await this.snapshot(transaction);
    this.state.pending = {
      ...backup,
      from: previousState.active,
      previous: previousState.previous || null,
    };
    this.save();
    try {
      this.state.active = descriptor(target);
      this.state.previous = descriptor(previousState.active);
      this.save();
      await this.afterSwitch();
      delete this.state.pending;
      this.state.message = message;
      this.save();
      this.progress('idle', message);
      await fs.promises
        .rm(transaction, { recursive: true, force: true })
        .catch(() => {});
    } catch (error) {
      await this.beforeSwitch();
      await this.restoreHome(this.state.pending);
      this.state = previousState;
      this.state.message = 'CLI 启动验证失败，已恢复原版本和会话数据。';
      this.save();
      this.progress('error', this.state.message);
      throw new Error(this.state.message + ' ' + error.message);
    }
  }
  install() {
    return this.locked(async (signal) => {
      this.progress('checking', '正在确认最新稳定版本…');
      const release = await this.fetchRelease({ signal });
      this.latest = release;
      if (compare(release.version, this.state.active.version) <= 0) {
        this.progress('idle', '当前已是最新稳定版本。');
        return this.status();
      }
      const id = crypto.randomBytes(8).toString('hex'),
        cache = path.join(this.work, 'downloads'),
        staging = path.join(this.runtime, 'cli-versions', '.staging-' + id),
        file = path.join(cache, id + '.tar.gz'),
        probeHome = path.join(this.work, 'probes', id);
      await fs.promises.mkdir(cache, { recursive: true });
      await fs.promises.mkdir(staging, { recursive: true });
      try {
        this.progress('downloading', '正在下载完整 CLI 运行包…', {
          total: release.size,
        });
        await this.download(release, file, {
          signal,
          progress: (bytes, total) =>
            this.progress(
              'downloading',
              `正在下载 ${Math.round((bytes / total) * 100)}%`,
              { bytes, total },
            ),
        });
        signal.throwIfAborted();
        this.progress('extracting', '校验通过，正在解包…');
        await this.extract(file, staging, { signal });
        await validatePackage(staging, release.version);
        signal.throwIfAborted();
        this.progress('testing', '正在测试新版 CLI…');
        await this.probe({
          directory: staging,
          version: release.version,
          home: probeHome,
          settings: this.getSettings(),
        });
        signal.throwIfAborted();
        const target = {
          version: release.version,
          directory: `cli-versions/${release.version}-${id}`,
        };
        await fs.promises.rename(staging, this.absolute(target));
        await this.switchTo(
          target,
          `已更新到 CLI ${release.version}，可继续对话。`,
          signal,
        );
        return this.status();
      } finally {
        await Promise.allSettled([
          fs.promises.rm(file, { force: true }),
          fs.promises.rm(staging, { recursive: true, force: true }),
          fs.promises.rm(probeHome, { recursive: true, force: true }),
        ]);
      }
    });
  }
  rollback() {
    return this.locked(async (signal) => {
      const previous = this.state.previous;
      if (!previous) throw new Error('还没有可以恢复的上一版 CLI。');
      await validatePackage(this.absolute(previous), previous.version);
      await this.switchTo(
        previous,
        `已恢复到 CLI ${previous.version}。`,
        signal,
      );
      return this.status();
    });
  }
}
module.exports = {
  CliUpdater,
  selectRelease,
  compare,
  safeEntry,
  safeUrl,
  extractPackage,
  validatePackage,
  probeCli,
  downloadPackage,
  verifiedDownload,
};
