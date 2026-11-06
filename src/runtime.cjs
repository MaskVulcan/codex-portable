'use strict';
const fs = require('node:fs');
const path = require('node:path');

function firstFile(candidates) {
  return candidates.find(
    (p) => p && fs.existsSync(p) && fs.statSync(p).isFile(),
  );
}
function configurePythonOverlay(python, dataDirectory) {
  const overlay = path.join(dataDirectory, 'python-packages');
  if (!fs.existsSync(overlay)) return;
  const site = path.join(path.dirname(python), 'Lib', 'site-packages');
  if (!fs.existsSync(site)) return;
  const file = path.join(site, 'codex_portable_inherited.pth'),
    text = 'import sys; sys.path.insert(0, ' + JSON.stringify(overlay) + ')\n';
  let previous = '';
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch {}
  if (previous !== text) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    } catch {}
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  }
}
function resolveRuntime({
  appDirectory,
  dataDirectory,
  developmentDirectory,
  codeOverride,
  pythonOverride,
}) {
  const legacy = path.join(dataDirectory, 'runtime');
  const codex =
    codeOverride ||
    firstFile([
      path.join(appDirectory, 'codex', 'bin', 'codex.exe'),
      developmentDirectory &&
        path.join(developmentDirectory, 'payload', 'codex', 'bin', 'codex.exe'),
      path.join(legacy, 'codex', 'bin', 'codex.exe'),
    ]);
  // Old installations may contain additional pip packages; use that Python in
  // place so upgrading this app never copies or overwrites the user's libraries.
  const python =
    pythonOverride ||
    firstFile([
      path.join(legacy, 'python', 'python.exe'),
      path.join(appDirectory, 'python', 'python.exe'),
      developmentDirectory &&
        path.join(developmentDirectory, 'payload', 'python', 'python.exe'),
    ]);
  const tools = firstFile([
    path.join(appDirectory, 'scripts', 'office_tools.py'),
    developmentDirectory &&
      path.join(developmentDirectory, 'assets', 'office_tools.py'),
  ]);
  if (!codex || !python || !tools)
    throw new Error(
      '运行文件不完整。请解压整个文件夹，并将 EXE、codex、python、scripts 放在一起。',
    );
  return {
    codex,
    python,
    tools,
    codexDirectory: codeOverride
      ? path.dirname(path.dirname(codeOverride))
      : path.dirname(path.dirname(codex)),
    legacyPython: python.startsWith(path.join(legacy, 'python') + path.sep),
  };
}
module.exports = { resolveRuntime, configurePythonOverlay };
