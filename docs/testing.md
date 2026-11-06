# 测试与验证

## 离线自动检查

Node.js 22+（推荐 24）运行 `npm test`；Python 3.12+ 运行：

```bash
python -m unittest discover -s test -p '*_test.py'
```

覆盖设置持久化、附件、草稿、任务隔离、停止、备份恢复、继承、更新回退和公共构建凭证隔离。
继承回归会禁止目录枚举，确认完成标记能让重复启动跳过扫描。
部分文件系统用例需要符号链接支持，默认 CI 在 Linux 上执行。

## 界面检查

在准备好 npm 依赖和桌宠资源后：

```bash
npx playwright install chromium
node scripts/ui-smoke.cjs
node scripts/usability-ui.cjs
```

界面检查使用模拟后端，不调用模型。Linux 无桌面环境缺少库时可按实际环境准备 Chromium 依赖；
`scripts/prepare-ui-test.py` 是 Ubuntu/WSL 的本地库和中文字体辅助脚本，不更改系统安装。

## 真实模型与 Electron 集成检查

这些检查调用已配置中转，并在独立 `test-output/` 下生成文件和历史。
先按 README 准备私人 `payload/provisioning.json`，在本机安装 Codex CLI 及带文档库的 Python。
通过环境变量指定路径，不依赖某位开发者的目录：

| 变量               | 用途                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `TEST_CODEX`       | 本机 Codex CLI 可执行文件，默认从 `~/.local/bin/codex` 或 PATH 查找 |
| `TEST_PYTHON`      | 本机 Python，默认 `.test-venv`，其次 PATH 的 python/python3         |
| `TEST_ELECTRON`    | 启动检查使用的 Electron，默认 npm 安装的 Electron                   |
| `TEST_PACKAGE_DIR` | Electron 集成检查对应的 Windows 目录包                              |

Linux/WSL 示例：

```bash
python -m venv .test-venv
.test-venv/bin/python -m pip install python-docx PyMuPDF Pillow openpyxl reportlab pypdf requests beautifulsoup4
export TEST_CODEX=/path/to/codex
export TEST_PYTHON="$PWD/.test-venv/bin/python"
node scripts/integration.cjs
node scripts/main-smoke.cjs
node scripts/usability-smoke.cjs
```

`integration.cjs` 生成 `main-smoke.cjs` 使用的文档和图片夹具。
真实 Electron 检查通过 Electron 执行 `scripts/electron-smoke.cjs`、`pet-electron.cjs`、
`inheritance-electron.cjs` 和 `novice-electron.cjs`，支持 `TEST_PACKAGE_DIR`。
Linux 无桌面模式可使用 `--no-sandbox --ozone-platform=headless --disable-gpu`；
Live2D 渲染检查改用 `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`。

`scripts/release.py` 用于本项目的私人完整验收包：要求所有验收报告已生成，
校验后再打包并扫描源码是否含预置令牌。普通构建直接使用 README 的 `build:win`，
不必生成全部验收报告。私人 Windows 压缩包可能带中转令牌，不要上传到公共仓库或公开 Release。

## 验证边界

Linux 上的 Electron/模型验证不能代替 Windows 10/11 + WPS 原机验证。
原机重点检查截图粘贴、中文长路径、WPS 文件占用、托盘、多屏、缩放和断网恢复。
文件结构能打开的检查不验证事实正确性和排版质量。
