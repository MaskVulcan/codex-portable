# Codex Portable

Windows 10/11 x64 便携文件助手：Electron 界面 + 官方 Codex app-server + 便携 Python。
完整解压后双击运行，无需安装客户端、Node 或 Python。模型请求需要可用的中转站和网络。
这是独立客户端，与 OpenAI 官方 Codex App 无关。

## 使用

1. 将整个程序目录解压到普通可写文件夹，双击 `Codex Portable.exe`，不要直接从压缩包预览运行。
2. 首次在“连接设置”填写中转 API 地址和令牌。可保存多套配置；示例提供 `axhan` 和 `4router`，令牌为空。
3. 选择工作文件夹，拖入文件、按 `Ctrl+V` 粘贴截图，或通过 `@` 选择目录里的文件。
4. 输入要求；每次任务的成果保存到 `工作目录/输出/时间-任务名-编号/`，结果卡可打开、另存和打包。

默认模型 `gpt-6.1-sol`、思考强度 `xhigh`、Fast 开启，均可调整。Fast、联网搜索及模型是否可用取决于中转支持。
默认 **YOLO 全权限**：以当前 Windows 用户权限执行操作，不请求命令批准，不自动提权。

## 功能

- DOCX、PDF、图片及表格处理；预装 Python、pip、python-docx、PyMuPDF、Pillow、openpyxl 等。
- 多套中转配置、模型选择、真实请求测速；官方 CLI 检查更新、更新失败恢复及回退。
- 对话历史、按会话保存文字和附件草稿；主窗口和快捷聊天共享待答问题。
- 准备文件、连接、运行和校验均可停止；失败后重试、换线路或重新定位工作目录。
- 每次任务独立结果目录、导入原件快照和处理副本；归档找回、备份恢复、脱敏诊断。
- 本地 BongoCat Live2D 桌宠：摸头互动、拖文件、双击快捷聊天、任务状态和完成提醒。
- Chrome/Edge 浏览器扩展：通过当前用户可见网页复用登录状态，按主题读取已加载帖子和评论并逐屏保存截图；批量进度、错误和断点可找回。
- 关闭主窗口默认收进托盘继续任务；退出请使用托盘或桌宠菜单。快捷键 `Ctrl+Alt+P`。

文件存在、非空和结构检查不代表内容及排版已验收。原件快照便于恢复；YOLO 仍有权限访问副本外的文件。
老 `.doc` 和导出 PDF 会尝试已安装的 WPS/Word，具体自动化能力取决于办公软件版本。
扫描件使用模型视觉和 PDF 渲染，不额外捆绑大型 OCR 模型。

## 浏览器采集小红书

点左下角“浏览器采集”，按说明在 Chrome/Edge 的扩展管理页加载解压在程序同级的 `browser-extension/`，再粘贴配对信息。只需首次设置。
Chrome 会提示扩展正在调试页面。它只连接本机助手，并在当前可见标签页读取公开显示的正文/评论、点按、滚动和截图；不会读取账号密码/Cookie或访问隐藏私有接口。采集期间可在浏览器自己登录。

例如输入：“围绕通勤穿搭，收集 20 篇相关笔记，每篇看 5 屏评论截图，最后整理一个索引。”助手先搜索并挑选链接，再按每批最多 10 篇处理。完成的笔记、实际加载评论、逐屏 PNG、JSON 记录和 CSV 索引边采边存；断线或停止后可在进度卡片点“继续采集”。处理同一标签页时请勿同时手工操作。浏览器需要保持开启，程序退出后不会继续采集。扩展显示浏览器调试提示；点扩展中的“断开连接”会立即关闭调试连接。

小红书可能需要登录、验证码或限制访问；请在浏览器自行处理，助手会停下来等待。采集速度由页面加载与评论加载情况决定。默认每篇最多 5 屏，可要求 1–20 屏；只收集浏览器实际加载的内容，不保证全部评论、楼中楼或所有搜索结果。截图和索引会保存在本次任务的“输出”目录。

## 升级与数据

关闭旧程序，将新版完整目录解压在旧版本目录旁，首次启动自动查找并继承对话、原生上下文、附件、配置和桌宠偏好，保留旧目录。
也支持解压工具多套一层同名目录的布局。重复历史去重，分支保留，额外 Python 包以覆盖层继承。

**只在首次启动查找**：结果记在 `data/inheritance.json`。成功或没有找到旧版后，后续启动直接跳过扫描；中断时下次重试。
需要补充导入时使用“帮助与数据”手动导入。不要删除该标记来做日常清理。

程序从 EXE 同级查找运行文件，首次和重复启动均不再自解压或复制运行环境。
搬家请复制整个程序文件夹，不能只复制 EXE。也可将完整旧 `data` 复制到新版 EXE 旁。

```text
Codex Portable.exe
codex/          官方 CLI
python/         便携 Python 和办公库
scripts/        办公工具脚本
config/         中转预置及版本信息
pets/           桌宠资源
resources/      Electron 应用资源
locales/        界面运行资源
其他 DLL 等     界面运行文件
data/           使用后生成：历史、设置、附件、快照、CLI 更新
```

`data/settings.json` 和自定义 `config/provisioning.json` 含令牌；数据备份也包含令牌，请按私人文件保管。
不添加系统 PATH、文件关联、开机启动或卸载项；系统和默认软件仍可能自行记录使用痕迹。

## 构建

需要 Node.js 22+（推荐 24）、Python 3.12+ 和网络；可在 Windows 或 Linux/WSL 构建 Windows x64 目录包。
Windows 准备脚本使用 npm 依赖内的 7-Zip；Linux 在缺少 7-Zip 时下载本地工具。

```bash
npm ci
python scripts/prepare.py
python scripts/prepare-pet.py
npm test
npm run build:win
```

输出为 `dist/win-unpacked/`，完整压缩这个目录即可分发。构建时 Electron 由 electron-builder 自动下载。
`prepare.py` 生成 CLI/Python 运行环境、版本布局和空令牌配置；**不会读取本机 Codex 登录或中转凭证**。
桌宠资源仅在准备时下载，运行时离线读取。

私人构建可将 `config/provisioning.example.json` 复制为被 Git 忽略的 `config/provisioning.local.json`，填写各配置的令牌后明确指定：

```bash
python scripts/prepare.py --provisioning config/provisioning.local.json
```

未指定参数时始终使用空令牌示例，包括覆盖此前准备过的私人配置。切换构建方式后请重新打包。
自定义信任证书可通过 `CODEX_PORTABLE_CA_FILE` 或 Python 标准 `SSL_CERT_FILE` 指定，下载保持 TLS 校验。
本仓库只存源码、空令牌示例和测试，不上传运行数据、下载缓存、第三方模型或私人发行包。

## 测试

```bash
npm test
python -m unittest discover -s test -p '*_test.py'
```

以上自动检查不调用真实模型，也不需要令牌。GitHub Actions 在 Linux 上执行。
界面和真实中转测试说明见 [docs/testing.md](docs/testing.md)。
已在 Linux 的真实 Electron、Chromium 和中转请求中验证；Windows/WPS 原机兼容性仍需实测。

## 代码结构

- `src/main.cjs`：Electron 窗口、IPC、任务与结果流程。
- `src/core.cjs`：配置、历史及 Codex RPC；`workflow.cjs`、`data-tools.cjs`：任务、文件及备份。
- `src/ui/`：主界面；`src/pet/` 和 `pet-controller.cjs`：桌宠与快捷聊天。
- `browser-extension/`、`src/browser-bridge.cjs`、`browser-collection.cjs`：用户浏览器连接、可视化批量采集与截图。
- `assets/browser_mcp.py`：连接本机扩展的轻量 MCP 适配器，仅用 Python 标准库。
- `src/inheritance.cjs`、`updater.cjs`：旧版继承与 CLI 更新恢复。
- `assets/office_tools.py`：办公处理与文件校验。
- `scripts/`：准备、集成测试及私人发行验证；`test/`：离线自动测试。

原创代码使用 [MIT](LICENSE)，下载的第三方组件遵循各自条款，见 [THIRD_PARTY.md](THIRD_PARTY.md)。
