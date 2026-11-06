'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const root = path.resolve(__dirname, '..');
const localCodex = path.join(os.homedir(), '.local', 'bin', 'codex');
const localPython = path.join(
  root,
  '.test-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const codex =
  process.env.TEST_CODEX ||
  process.env.PORTABLE_CODEX_EXE ||
  (fs.existsSync(localCodex) ? localCodex : 'codex');
const python =
  process.env.TEST_PYTHON ||
  process.env.PORTABLE_PYTHON_EXE ||
  (fs.existsSync(localPython)
    ? localPython
    : process.platform === 'win32'
      ? 'python'
      : 'python3');
function resolveCommand(command) {
  if (
    path.isAbsolute(command) ||
    command.includes('/') ||
    command.includes('\\')
  )
    return fs.realpathSync(command);
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter))
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        fs.accessSync(
          candidate,
          process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {}
    }
  throw new Error('Test executable not found; set TEST_CODEX or TEST_PYTHON.');
}
const electron = () => process.env.TEST_ELECTRON || require('electron');
module.exports = { codex, python, electron, resolveCommand };
