'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readJson, atomicJson } = require('./persistence.cjs');
const validConversationId = (id) =>
  typeof id === 'string' && /^[a-z0-9-]{8,80}$/i.test(id);
const MARKER = 'inheritance.json';
const versionPattern = /codex[- _]?portable[- _]v?(\d+\.\d+\.\d+)/i;
const knownDirectory = /^codex[- _]?portable(?:[- _]|$)/i;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function compareVersions(a, b) {
  const aa = (a || '0.0.0').split('.').map(Number),
    bb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++)
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
function dataPresent(dir) {
  return (
    exists(path.join(dir, 'settings.json')) ||
    entries(path.join(dir, 'conversations')).some(
      (e) => e.isFile() && e.name.endsWith('.json'),
    )
  );
}
function installation(dir) {
  const data = path.join(dir, 'data');
  if (!dataPresent(data)) return null;
  const named = knownDirectory.test(path.basename(dir)),
    oldExecutable = entries(dir).find(
      (e) =>
        e.isFile() &&
        /^Codex-Portable-\d+\.\d+\.\d+-win-x64\.exe$/i.test(e.name),
    ),
    executable =
      exists(path.join(dir, 'Codex Portable.exe')) || !!oldExecutable;
  if (!named && !executable) return null;
  const manifest = readJson(path.join(dir, 'config', 'manifest.json'), {}),
    version =
      manifest.appVersion ||
      versionPattern.exec(path.basename(dir))?.[1] ||
      versionPattern.exec(oldExecutable?.name || '')?.[1] ||
      '0.0.0';
  return {
    directory: canonical(dir),
    data: canonical(data),
    version,
    activity: Math.max(
      mtime(path.join(data, 'settings.json')),
      mtime(path.join(data, 'conversations')),
    ),
    key: sha(canonical(data)).slice(0, 12),
  };
}
function findPreviousInstallations(appDirectory, root, currentVersion) {
  const current = canonical(appDirectory),
    target = canonical(root),
    parent = path.dirname(current),
    parents = [parent];
  if (knownDirectory.test(path.basename(parent)))
    parents.push(path.dirname(parent));
  const found = new Map();
  for (const base of [...new Set(parents)])
    for (const e of entries(base)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const dir = path.join(base, e.name),
        candidate = installation(dir);
      if (
        candidate &&
        candidate.directory !== current &&
        candidate.data !== target &&
        compareVersions(candidate.version, currentVersion) <= 0
      )
        found.set(candidate.data, candidate);
      // Windows "Extract all" can add one outer folder with the same version name.
      if (knownDirectory.test(e.name))
        for (const child of entries(dir)) {
          if (
            !child.isDirectory() ||
            child.isSymbolicLink() ||
            !knownDirectory.test(child.name)
          )
            continue;
          const inner = installation(path.join(dir, child.name));
          if (
            inner &&
            inner.directory !== current &&
            inner.data !== target &&
            compareVersions(inner.version, currentVersion) <= 0
          )
            found.set(inner.data, inner);
        }
    }
  return [...found.values()].sort(
    (a, b) => b.activity - a.activity || compareVersions(b.version, a.version),
  );
}
function rewriteString(text, mappings) {
  let output = text;
  for (const [from, to] of mappings) {
    const variants = [
      [from, to],
      [from.replace(/\\/g, '/'), to.replace(/\\/g, '/')],
      [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)],
    ];
    for (const [a, b] of variants)
      if (a && a !== b) output = output.split(a).join(b);
  }
  return output;
}
function rewrite(value, mappings) {
  if (typeof value === 'string') return rewriteString(value, mappings);
  if (Array.isArray(value)) return value.map((v) => rewrite(v, mappings));
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewrite(v, mappings)]),
    );
  return value;
}
async function walk(dir, callback) {
  for (const e of entries(dir)) {
    if (e.isSymbolicLink()) continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory()) await walk(file, callback);
    else if (e.isFile()) await callback(file);
  }
}
async function sameFile(a, b) {
  if (!exists(a) || !exists(b) || fs.statSync(a).size !== fs.statSync(b).size)
    return false;
  return (
    sha(await fs.promises.readFile(a)) === sha(await fs.promises.readFile(b))
  );
}
async function copy(file, destination) {
  if (await sameFile(file, destination)) return false;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp =
    destination + '.inherit-' + crypto.randomBytes(4).toString('hex');
  await fs.promises.copyFile(file, temp);
  await fs.promises.chmod(temp, 0o600);
  if (exists(destination)) {
    try {
      await fs.promises.chmod(destination, 0o600);
    } catch {}
  }
  await fs.promises.rename(temp, destination);
  return true;
}
function messageKey(m) {
  return JSON.stringify({
    id: m.id,
    role: m.role,
    text: m.text,
    attachments: (m.attachments || []).map(
      (a) => a.name || path.basename(a.path || ''),
    ),
  });
}
function prefix(a, b) {
  return (
    a.length <= b.length &&
    a.every((m, i) => messageKey(m) === messageKey(b[i]))
  );
}
function branchId(id, messages) {
  const h = sha(id + JSON.stringify(messages.map(messageKey)));
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-4' +
    h.slice(13, 16) +
    '-a' +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
}
function settingProfiles(settings) {
  if (settings?.profiles?.length) return settings.profiles;
  return settings?.baseUrl
    ? [
        {
          id: 'relay-default',
          name: 'axhan',
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey || '',
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          fastMode: settings.fastMode,
          webSearch: settings.webSearch,
          models: settings.models,
        },
      ]
    : [];
}
function mergeSettings(current, sources) {
  const base = current || sources[0]?.settings;
  if (!base) return null;
  const profiles = settingProfiles(base).map((p) => ({ ...p }));
  for (const { settings, source } of sources)
    for (const profile of settingProfiles(settings)) {
      const same = profiles.find((p) => p.id === profile.id);
      if (!same) {
        profiles.push({ ...profile });
        continue;
      }
      if (same.baseUrl === profile.baseUrl && same.apiKey === profile.apiKey)
        continue;
      if (
        profiles.some(
          (p) => p.baseUrl === profile.baseUrl && p.apiKey === profile.apiKey,
        )
      )
        continue;
      const id =
        'inherited-' +
        sha(
          (profile.id || '') + (profile.baseUrl || '') + (profile.apiKey || ''),
        ).slice(0, 20);
      profiles.push({
        ...profile,
        id,
        name: (profile.name || '中转') + '（' + source.version + '）',
      });
    }
  return {
    ...base,
    profiles,
    activeProfileId: profiles.some((p) => p.id === base.activeProfileId)
      ? base.activeProfileId
      : profiles[0]?.id,
    importedPresetIds: [
      ...new Set([
        ...(base.importedPresetIds || []),
        ...sources.flatMap((s) => s.settings.importedPresetIds || []),
      ]),
    ],
  };
}

class Inheritor {
  constructor({
    appDirectory,
    root,
    version,
    onProgress = () => {},
    databaseFactory,
  }) {
    Object.assign(this, {
      appDirectory,
      root,
      version,
      onProgress,
      databaseFactory,
    });
    this.marker = path.join(root, MARKER);
    this.work = path.join(root, '.inheritance-work');
  }
  inspect() {
    const previous = readJson(this.marker, null);
    if (previous?.completed)
      return { needed: false, report: { ...previous, newlyImported: false } };
    const sources = findPreviousInstallations(
      this.appDirectory,
      this.root,
      this.version,
    );
    if (!sources.length) {
      const report = {
        completed: true,
        version: this.version,
        sourceCount: 0,
        conversations: 0,
        archived: 0,
        sources: [],
        completedAt: new Date().toISOString(),
      };
      atomicJson(this.marker, report);
      return { needed: false, report: { ...report, newlyImported: false } };
    }
    return { needed: true, sources };
  }
  progress(message) {
    this.onProgress(message);
  }
  async run(sources) {
    this.progress('发现 ' + sources.length + ' 个旧版目录，正在整理历史…');
    await fs.promises.mkdir(this.work, { recursive: true });
    const started = readJson(this.marker, {});
    atomicJson(this.marker, {
      completed: false,
      version: this.version,
      startedAt: started.startedAt || new Date().toISOString(),
      sources: sources.map((s) => ({
        directory: s.directory,
        version: s.version,
      })),
    });
    this.sources = sources;
    this.mappings = new Map();
    this.importedNativeIds = new Set();
    let attachments = 0,
      logs = 0;
    const rollouts = new Map();
    for (const source of sources) {
      const native = path.join(source.data, 'codex-home'),
        targetNative = path.join(this.root, 'codex-home');
      const mappings = [
        [
          path.join(native, 'archived_sessions'),
          path.join(targetNative, 'archived_sessions', 'inherited'),
        ],
        [
          path.join(native, 'sessions'),
          path.join(targetNative, 'sessions', 'inherited'),
        ],
        [
          path.join(source.data, 'attachments'),
          path.join(this.root, 'attachments', 'inherited'),
        ],
        [
          path.join(source.directory, 'python'),
          path.join(this.appDirectory, 'python'),
        ],
        [
          path.join(source.directory, 'scripts'),
          path.join(this.appDirectory, 'scripts'),
        ],
        [
          path.join(source.directory, 'codex'),
          path.join(this.appDirectory, 'codex'),
        ],
        [source.data, this.root],
      ].sort((a, b) => b[0].length - a[0].length);
      this.mappings.set(source.key, mappings);
      this.progress('正在继承 ' + source.version + ' 的截图与上下文…');
      await walk(path.join(source.data, 'attachments'), async (file) => {
        const digest = sha(await fs.promises.readFile(file)),
          ext = path
            .extname(file)
            .replace(/[^.a-zA-Z0-9]/g, '')
            .slice(0, 12),
          destination = path.join(
            this.root,
            'attachments',
            'inherited',
            digest + ext,
          );
        mappings.push([file, destination]);
        if (await copy(file, destination)) attachments++;
      });
      for (const dir of ['sessions', 'archived_sessions'])
        await walk(path.join(native, dir), async (file) => {
          if (!file.endsWith('.jsonl')) return;
          const destination = path.join(
            targetNative,
            dir,
            'inherited',
            path.basename(file),
          );
          mappings.push([file, destination]);
          const text = await fs.promises.readFile(file, 'utf8'),
            lines = text.trimEnd().split('\n');
          let time = mtime(file);
          try {
            time = Date.parse(JSON.parse(lines.at(-1)).timestamp) || time;
          } catch {}
          const key = dir + '/' + path.basename(file),
            previous = rollouts.get(key);
          if (
            !previous ||
            time > previous.time ||
            (time === previous.time && text.length > previous.text.length)
          )
            rollouts.set(key, { text, time, source, destination });
        });
      mappings.sort((a, b) => b[0].length - a[0].length);
    }
    for (const item of rollouts.values()) {
      const mappings = this.mappings.get(item.source.key),
        rewritten = item.text
          .split('\n')
          .map((line) => {
            if (!line) return line;
            try {
              return JSON.stringify(rewrite(JSON.parse(line), mappings));
            } catch {
              return rewriteString(line, mappings);
            }
          })
          .join('\n');
      await fs.promises.mkdir(path.dirname(item.destination), {
        recursive: true,
      });
      if (
        !exists(item.destination) ||
        fs.readFileSync(item.destination, 'utf8') !== rewritten
      ) {
        await fs.promises.writeFile(item.destination, rewritten, {
          encoding: 'utf8',
          mode: 0o600,
        });
        logs++;
      }
    }
    this.progress('正在合并对话列表与配置…');
    for (const source of sources)
      await walk(path.join(source.data, 'originals'), async (file) => {
        const destination = path.join(
          this.root,
          'originals',
          path.relative(path.join(source.data, 'originals'), file),
        );
        if (!exists(destination)) await copy(file, destination);
      });
    const conversations = new Map(),
      branches = [],
      allMappings = [...this.mappings.values()]
        .flat()
        .sort((a, b) => b[0].length - a[0].length);
    const loadChats = (data, source) => {
      for (const folder of ['conversations', 'archived'])
        for (const e of entries(path.join(data, folder))) {
          if (!e.isFile() || !e.name.endsWith('.json')) continue;
          const file = path.join(data, folder, e.name),
            chat = readJson(file, null);
          if (
            !chat ||
            !validConversationId(chat.id) ||
            !Array.isArray(chat.messages)
          )
            continue;
          const migrated = rewrite(
            chat,
            source ? this.mappings.get(source.key) : allMappings,
          );
          if (source) {
            migrated.inheritedFrom = {
              version: source.version,
              directory: source.directory,
            };
            if (chat.threadId) this.importedNativeIds.add(chat.threadId);
          }
          migrated.busy = false;
          migrated.turnId = null;
          for (const m of migrated.messages) m.streaming = false;
          if (chat.busy) migrated.status = '上次任务已停止';
          const candidate = {
              chat: migrated,
              folder,
              source,
              score: Number(chat.updatedAt) || mtime(file),
            },
            existing = conversations.get(chat.id);
          if (!existing) {
            conversations.set(chat.id, candidate);
            continue;
          }
          const winner =
              candidate.score > existing.score ||
              (candidate.score === existing.score &&
                candidate.chat.messages.length > existing.chat.messages.length)
                ? candidate
                : existing,
            other = winner === candidate ? existing : candidate;
          if (
            !prefix(other.chat.messages, winner.chat.messages) &&
            !prefix(winner.chat.messages, other.chat.messages)
          ) {
            const branch = structuredClone(other.chat);
            branch.id = branchId(other.chat.id, other.chat.messages);
            branch.title = (branch.title || '对话') + '（历史分支）';
            branch.inheritedThreadId = branch.threadId;
            branch.threadId = null;
            branch.inheritedHistory = true;
            branches.push({
              chat: branch,
              folder: other.folder,
              source: other.source,
              score: other.score,
            });
          }
          conversations.set(chat.id, winner);
        }
    };
    loadChats(this.root, null);
    for (const source of sources) loadChats(source.data, source);
    for (const branch of branches)
      if (!conversations.has(branch.chat.id))
        conversations.set(branch.chat.id, branch);
    let active = 0,
      archived = 0;
    for (const entry of conversations.values()) {
      const file = path.join(this.root, entry.folder, entry.chat.id + '.json');
      atomicJson(file, entry.chat);
      if (entry.folder === 'archived') archived++;
      else active++;
      const other = path.join(
        this.root,
        entry.folder === 'archived' ? 'conversations' : 'archived',
        entry.chat.id + '.json',
      );
      if (exists(other)) {
        await fs.promises.mkdir(path.join(this.work, 'superseded'), {
          recursive: true,
        });
        await fs.promises.rename(
          other,
          path.join(
            this.work,
            'superseded',
            entry.chat.id + '-' + path.basename(path.dirname(other)) + '.json',
          ),
        );
      }
    }
    const sourceSettings = sources
      .map((source) => ({
        source,
        settings: readJson(path.join(source.data, 'settings.json'), null),
      }))
      .filter((x) => x.settings);
    const merged = mergeSettings(
      readJson(path.join(this.root, 'settings.json'), null),
      sourceSettings,
    );
    if (merged)
      atomicJson(
        path.join(this.root, 'settings.json'),
        rewrite(
          merged,
          sourceSettings[0]
            ? this.mappings.get(sourceSettings[0].source.key)
            : [],
        ),
      );
    for (const name of ['pet.json'])
      if (!exists(path.join(this.root, name))) {
        const source = sources.find((s) => exists(path.join(s.data, name)));
        if (source)
          atomicJson(
            path.join(this.root, name),
            readJson(path.join(source.data, name), {}),
          );
      }
    const workspaceFile = path.join(this.root, 'workspace.json'),
      workspace = readJson(workspaceFile, { drafts: {} });
    workspace.drafts ||= {};
    for (const source of sources) {
      const old = readJson(path.join(source.data, 'workspace.json'), null);
      if (!old) continue;
      for (const [id, draft] of Object.entries(old.drafts || {}))
        if (!workspace.drafts[id])
          workspace.drafts[id] = rewrite(draft, this.mappings.get(source.key));
    }
    if (Object.keys(workspace.drafts).length)
      atomicJson(workspaceFile, workspace);
    this.progress('正在继承可继续聊天的原生索引…');
    const native = await this.nativeDatabases(conversations);
    this.progress('正在保留旧版额外安装的工具…');
    const extensions = await this.pythonExtensions();
    await this.cliVersions();
    const report = {
      completed: true,
      version: this.version,
      sourceCount: sources.length,
      conversations: active,
      archived,
      branches: branches.length,
      attachments,
      nativeRollouts: logs,
      nativeDatabases: native,
      pythonExtensions: extensions,
      sources: sources.map((s) => ({
        directory: s.directory,
        version: s.version,
      })),
      completedAt: new Date().toISOString(),
    };
    atomicJson(this.marker, report);
    await fs.promises
      .rm(this.work, { recursive: true, force: true })
      .catch(() => {});
    return { ...report, newlyImported: true };
  }
  database() {
    if (this.databaseFactory) return this.databaseFactory;
    try {
      return require('node:sqlite').DatabaseSync;
    } catch {
      throw new Error('当前运行环境缺少对话数据库支持，旧数据已保留。');
    }
  }
  async nativeDatabases(conversations) {
    const home = path.join(this.root, 'codex-home'),
      all = [
        { data: this.root, key: 'current', mappings: [] },
        ...this.sources.map((s) => ({
          ...s,
          mappings: this.mappings.get(s.key),
        })),
      ],
      names = new Set();
    for (const s of all)
      for (const e of entries(path.join(s.data, 'codex-home')))
        if (
          e.isFile() &&
          /^(state|thread_history|memories|goals)_\d+\.sqlite$/.test(e.name)
        )
          names.add(e.name);
    if (!names.size) return 0;
    const Database = this.database();
    await fs.promises.mkdir(home, { recursive: true });
    let count = 0;
    const importedThreads = this.importedNativeIds;
    const preferred = new Map(
      [...conversations.values()]
        .filter((e) => e.chat.threadId)
        .map((e) => [e.chat.threadId, e.source?.key || 'current']),
    );
    for (const name of [...names].sort(
      (a, b) =>
        (a.startsWith('state_') ? 0 : 1) - (b.startsWith('state_') ? 0 : 1) ||
        a.localeCompare(b),
    )) {
      const available = [];
      for (const s of all) {
        const file = path.join(s.data, 'codex-home', name);
        if (!exists(file)) continue;
        const db = new Database(file, { readOnly: true });
        try {
          const schemas = db
            .prepare(
              "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all();
          const score = schemas.reduce(
            (n, row) => n + (row.sql?.length || 0),
            0,
          );
          available.push({ source: s, file, score });
        } finally {
          db.close();
        }
      }
      available.sort((a, b) => b.score - a.score);
      if (!available.length) continue;
      const stage = path.join(this.work, name);
      for (const suffix of ['', '-wal', '-shm'])
        await fs.promises.rm(stage + suffix, { force: true });
      let source = new Database(available[0].file, { readOnly: true });
      try {
        source.exec("VACUUM INTO '" + stage.replace(/'/g, "''") + "'");
      } finally {
        source.close();
      }
      const target = new Database(stage);
      target.exec('PRAGMA foreign_keys=OFF; BEGIN');
      try {
        // Base rows also need their original data paths rewritten.
        const ordered = [available[0], ...available.slice(1).reverse()];
        for (const entry of ordered) {
          source = new Database(entry.file, { readOnly: true });
          try {
            const tables = source
              .prepare(
                "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
              )
              .all();
            for (const table of tables) {
              if (
                table.name === '_sqlx_migrations' ||
                /^(backfill_state|rollout_migration|remote_control|external_agent_config)/.test(
                  table.name,
                )
              )
                continue;
              const q = '"' + table.name.replace(/"/g, '""') + '"';
              if (
                !target
                  .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                  )
                  .get(table.name)
              ) {
                if (table.sql) target.exec(table.sql);
                else continue;
              }
              const destColumns = target
                  .prepare('PRAGMA table_info(' + q + ')')
                  .all(),
                columns = source
                  .prepare('PRAGMA table_info(' + q + ')')
                  .all()
                  .map((c) => c.name)
                  .filter((c) => destColumns.some((d) => d.name === c));
              if (!columns.length) continue;
              const insert = target.prepare(
                'INSERT OR REPLACE INTO ' +
                  q +
                  ' (' +
                  columns
                    .map((c) => '"' + c.replace(/"/g, '""') + '"')
                    .join(',') +
                  ') VALUES (' +
                  columns.map(() => '?').join(',') +
                  ')',
              );
              for (const row of source
                .prepare('SELECT * FROM ' + q)
                .iterate()) {
                const threadId =
                  table.name === 'threads' ? row.id : row.thread_id;
                if (
                  threadId &&
                  preferred.has(threadId) &&
                  available.some(
                    (a) => a.source.key === preferred.get(threadId),
                  ) &&
                  preferred.get(threadId) !== entry.source.key
                )
                  continue;
                if (table.name === 'threads' && entry.source.key !== 'current')
                  importedThreads.add(row.id);
                const values = columns.map((c) => {
                  let value = row[c];
                  if (typeof value === 'string') {
                    if (
                      c.endsWith('_json') ||
                      c === 'payload' ||
                      c === 'input_schema'
                    ) {
                      try {
                        value = JSON.stringify(
                          rewrite(JSON.parse(value), entry.source.mappings),
                        );
                      } catch {
                        value = rewriteString(value, entry.source.mappings);
                      }
                    } else value = rewriteString(value, entry.source.mappings);
                  }
                  return value;
                });
                insert.run(...values);
              }
            }
          } finally {
            source.close();
          }
        }
        if (name.startsWith('thread_history_'))
          for (const table of [
            'thread_turns',
            'thread_items',
            'thread_realtime_items',
            'thread_history_projection_state',
          ]) {
            if (
              !target
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                )
                .get(table)
            )
              continue;
            const remove = target.prepare(
              'DELETE FROM "' + table + '" WHERE thread_id=?',
            );
            for (const id of importedThreads) remove.run(id);
          }
        target.exec('COMMIT');
      } catch (error) {
        try {
          target.exec('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        target.close();
      }
      const destination = path.join(home, name);
      // No Codex backend has been started yet. Move stale WAL/SHM aside before
      // replacing the flattened snapshot so old pages cannot reappear.
      const backupId = crypto.randomBytes(4).toString('hex');
      for (const suffix of ['', '-wal', '-shm'])
        if (exists(destination + suffix))
          await fs.promises.rename(
            destination + suffix,
            path.join(this.work, 'previous-' + backupId + '-' + name + suffix),
          );
      await copy(stage, destination);
      count++;
    }
    return count;
  }
  async pythonExtensions() {
    const targetPython = path.join(this.appDirectory, 'python'),
      overlay = path.join(this.root, 'python-packages');
    let added = 0;
    const group = (name) =>
      name.endsWith('.dist-info')
        ? 'metadata:' +
          name
            .replace(/-\d[^/]*\.dist-info$/, '')
            .toLowerCase()
            .replace(/[-_.]/g, '-')
        : name;
    const seen = new Set(entries(overlay).map((e) => group(e.name)));
    for (const source of this.sources) {
      const python = exists(path.join(source.data, 'runtime/python/python.exe'))
        ? path.join(source.data, 'runtime/python')
        : path.join(source.directory, 'python');
      if (!exists(path.join(python, 'python.exe'))) continue;
      const oldAbi = entries(python).find((e) =>
          /^python\d+\._pth$/.test(e.name),
        )?.name,
        newAbi = entries(targetPython).find((e) =>
          /^python\d+\._pth$/.test(e.name),
        )?.name;
      if (oldAbi && newAbi && oldAbi !== newAbi) {
        const legacy = path.join(this.root, 'runtime/python');
        if (!exists(path.join(legacy, 'python.exe')))
          await fs.promises.cp(python, legacy, {
            recursive: true,
            filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
          });
        continue;
      }
      const packages = path.join(python, 'Lib/site-packages');
      for (const e of entries(packages)) {
        if (
          e.isSymbolicLink() ||
          e.name === '__pycache__' ||
          e.name === 'codex_portable_inherited.pth'
        )
          continue;
        const identity = group(e.name);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const item = path.join(packages, e.name),
          baseline = path.join(targetPython, 'Lib/site-packages', e.name);
        let differs = false;
        if (e.isFile()) differs = !(await sameFile(item, baseline));
        else
          await walk(item, async (file) => {
            if (
              !file.includes(path.sep + '__pycache__' + path.sep) &&
              !(await sameFile(
                file,
                path.join(baseline, path.relative(item, file)),
              ))
            )
              differs = true;
          });
        if (!differs) continue;
        const copyItem = async (file) => {
          if (
            file.includes(path.sep + '__pycache__' + path.sep) ||
            /\.pyc$/.test(file)
          )
            return;
          const destination = e.isDirectory()
            ? path.join(overlay, e.name, path.relative(item, file))
            : path.join(overlay, e.name);
          if (await copy(file, destination)) added++;
        };
        if (e.isDirectory()) await walk(item, copyItem);
        else await copyItem(item);
      }
    }
    return added;
  }
  async cliVersions() {
    const stateFile = path.join(this.root, 'runtime/.cli-state.json');
    if (exists(stateFile)) return;
    for (const source of this.sources) {
      const state = readJson(
        path.join(source.data, 'runtime/.cli-state.json'),
        null,
      );
      if (!state || state.pending) continue;
      const descriptors = [state.active, state.previous].filter(Boolean);
      let okay = true;
      for (const d of descriptors) {
        if (!/^(codex|cli-versions\/[\w.-]+)$/.test(d.directory)) {
          okay = false;
          break;
        }
        const dir = path.join(source.data, 'runtime', d.directory);
        if (d.directory === 'codex') {
          const oldVersion =
              readJson(path.join(dir, 'codex-package.json'), {}).version ||
              '0.0.0',
            newVersion =
              readJson(
                path.join(this.appDirectory, 'codex/codex-package.json'),
                {},
              ).version || '0.0.0';
          if (
            compareVersions(oldVersion, newVersion) > 0 &&
            !exists(path.join(this.root, 'runtime/codex/bin/codex.exe'))
          )
            await fs.promises.cp(dir, path.join(this.root, 'runtime/codex'), {
              recursive: true,
              filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
            });
          continue;
        }
        if (!exists(path.join(dir, 'bin/codex.exe'))) {
          okay = false;
          break;
        }
        const destination = path.join(this.root, 'runtime', d.directory);
        if (!exists(path.join(destination, 'bin/codex.exe')))
          await fs.promises.cp(dir, destination, {
            recursive: true,
            filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
          });
      }
      if (okay) {
        atomicJson(stateFile, state);
        return;
      }
    }
  }
}
module.exports = {
  Inheritor,
  findPreviousInstallations,
  rewriteString,
  rewrite,
  mergeSettings,
};
