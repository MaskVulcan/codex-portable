'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  tar = require('tar'),
  yazl = require('yazl');
const { safeEntry } = require('./updater.cjs');
function zipFiles(destination, files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(),
      output = fs.createWriteStream(destination);
    zip.outputStream.on('error', reject).pipe(output);
    output.on('error', reject);
    output.on('close', () => resolve(destination));
    for (const f of files) zip.addFile(f.path, f.name.replace(/\\/g, '/'));
    zip.end();
  });
}
async function backupData(root, destination) {
  if (path.resolve(destination).startsWith(path.resolve(root) + path.sep))
    throw new Error('请把备份保存在程序 data 目录之外。');
  const include = fs
    .readdirSync(root)
    .filter((n) =>
      [
        'settings.json',
        'workspace.json',
        'pet.json',
        'inheritance.json',
        'conversations',
        'archived',
        'attachments',
        'originals',
        'python-packages',
        'codex-home',
      ].includes(n),
    );
  const ignored = new Set([
    '.tmp',
    'tmp',
    'plugins',
    'cache',
    'shell_snapshots',
    'logs',
    'thread-writer-locks',
    'app-server-control',
    'app-server-daemon',
  ]);
  await tar.c(
    {
      file: destination,
      cwd: root,
      gzip: true,
      portable: true,
      filter: (name) => !name.split(/[\\/]/).some((p) => ignored.has(p)),
    },
    include,
  );
  return destination;
}
async function extractBackup(file, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let size = 0,
    count = 0,
    bad = false;
  await tar.x({
    file,
    cwd: destination,
    strict: true,
    filter: (_name, entry) => {
      size += entry.size || 0;
      count++;
      const okay =
        safeEntry(entry) && size < 8 * 1024 * 1024 * 1024 && count < 100000;
      if (!okay) bad = true;
      return okay;
    },
  });
  if (bad) throw new Error('备份包含不支持的路径或体积过大，未导入。');
}
module.exports = { zipFiles, backupData, extractBackup };
