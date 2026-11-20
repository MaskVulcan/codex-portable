"""Package the ready-to-run directory; never wrap it in a self-extracting EXE."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'release'
DEST.mkdir(exist_ok=True)
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
DISTRIBUTION = ROOT / 'dist' / 'win-unpacked'
FOLDER = f'Codex-Portable-{VERSION}-win-x64'
EXE = DISTRIBUTION / 'Codex Portable.exe'
REPORTS = ['live', 'main', 'ui', 'fast', 'updater', 'profiles', 'reported-data', 'electron', 'startup', 'benchmark', 'pet', 'inheritance', 'inheritance-boot', 'usability', 'usability-ui', 'novice', 'browser', 'browser-native', 'package']
checks = {}
for name in REPORTS:
    checks[name] = json.loads((ROOT / 'test-output' / name / 'report.json').read_text())
    assert checks[name]['passed']
assert checks['package']['layout'] == 'directory'
assert checks['package']['sha256'] == hashlib.sha256(EXE.read_bytes()).hexdigest()
assert checks['pet']['builtApplication'] and checks['pet']['live2dModelRendered'] and checks['pet']['live2dPatInteraction']
assert checks['inheritance']['nativeModelContextResumed'] and checks['inheritance-boot']['builtApplication']

readme = f'''Codex 便携文件助手 {VERSION} · Windows 10/11 64 位 · 目录便携版

1. 将整个 ZIP 解压到普通可写文件夹，例如桌面上的“文件助手”。
2. 双击 Codex Portable.exe，直接打开，不安装、不再解压到系统临时目录。
3. 选择工作文件夹，拖入文件或 Ctrl+V 粘贴截图，输入要做的事情。
4. 结果默认在工作文件夹的“输出/本次任务”目录，结果卡可打开、另存或打包。

1.2.0 改进：
  1.3.0 新增 Chrome/Edge 扩展桥接、主题批量帖子/评论/截图、断点续采及实时计划/输出/错误。
  首次打开左侧“浏览器采集”，按三步加载同级 browser-extension 并配对；无注册表或安装器。
  登录和验证码需要在网页完成。仅收集实际加载评论，不保证所有评论或楼中楼。
  扩展功能已用本地页面与真实 Chromium 调试/截图链路验证，小红书真实账号及 Windows 原机尚未验收。
  跨对话问题卡和草稿隔离，主窗口与快捷聊天共享；附件草稿可以恢复。
  从连接到校验均可停止；按错误原因重试、换线路或重新定位工作目录。
  任务使用独立结果目录；输入文件保留原件快照、优先处理副本。
  结果卡提供另存、打包、原件副本恢复；区分“已回答/已生成文件/部分完成”。
  新增归档找回、首次引导、常用任务、帮助、备份恢复和脱敏诊断。
  文件格式检查不等于内容/版式验收。YOLO 仍然拥有当前用户全权限。

目录布局：
  Codex Portable.exe    双击启动
  codex/                完整 Codex CLI 运行文件
  python/               便携 Python、pip 和预装文档/图片/表格处理库
  scripts/              办公处理脚本
  config/               预置中转配置
  pets/                 BongoCat 模型和素材
  data/                 历史、个人设置、截图附件、CLI 更新等运行数据
  resources/、locales/、DLL 等为界面运行文件，请保留。

程序按 EXE 所在目录定位，不依赖从哪里双击或当前工作目录。
首次和以后启动都直接使用现成工具，不复制 Codex/Python、不解包临时程序。
不要只复制 EXE，也不要从 ZIP 预览窗口直接运行。

从旧版升级（1.1.1 自动继承）：
  关闭旧版，把新版完整目录解压在旧版本目录旁边，首次打开会自动查找。
  找到旧版后会显示继承进度，合并历史、原生上下文、截图、中转配置及桌宠偏好。
  多版本相同对话去重，不同分支分别保留；旧目录不删除，后续启动不重复导入。
  记录在 data/inheritance.json。额外 Python 包会进入 data/python-packages。
  若新版不在旧版旁边，仍可把原 data 完整复制到新版 EXE 旁。
  保留整个旧 data，包括 data/runtime；原有 CLI 更新记录继续生效。
  旧 data/runtime/python 中后装的 Python 库会继续原地使用，不覆盖或搬运。
  新用户直接使用同级 python 目录。以后搬家时复制整个程序文件夹。

预置“axhan”和“4router”，无需 ChatGPT 登录。
顶部可切换中转和模型；连接设置中可保存、编辑和删除多套配置。
模型下拉：gpt-6.1-sol、gpt-6.1-terra、gpt-6-astra、gpt-6-sol、gpt-6-luna。
默认 gpt-6.1-sol、思考强度 xhigh、Fast 开启，可分别调整。
顶部“一键测速”用相同模型、参数和输出任务比较各条线路的首字和完成耗时。
测速发起真实简短请求，可停止；结果不自动切换，点击“使用”可切换。
默认 YOLO 全权限，拥有当前 Windows 用户权限；不会自动提权为管理员。
CLI 支持检查更新、一键更新、失败恢复和手动恢复上一版。
调用模型仍需要联网，Fast 和图片生成是否可用取决于中转支持。

可处理 DOCX、PDF、图片及表格，支持 Codex 按需编程安装 Python 库。
老 .doc 和导出 PDF 会尝试已安装 WPS/Word，自动化能力取决于办公软件版本。
保留了 1.0.4 的剪贴板图片、只读数据文件和 .tmp 恢复修复。

Bongo 桌面伙伴：
  默认显示一只本地 Live2D 小猫，眼睛跟随鼠标；单击摸头，双击快捷聊天。
  按住拖动可移动，右键有逗猫、大小、安静模式、隐藏和退出。
  可把文件拖到猫身上，在快捷聊天中输入任务；支持 Ctrl+V 粘贴截图。
  任务运行时猫会忙碌，完成/失败/需要输入时显示不同状态和提示。
  点击任务动态可回到对话或打开输出文件夹；Ctrl+Alt+P 打开快捷聊天。
  关闭主窗口默认隐藏到托盘，任务继续；退出请使用托盘或桌宠菜单的“退出”。
  左下角“Bongo 桌面伙伴”可开关、调整大小、置顶、完成提醒和安静模式。
  位置及偏好保存在 data/pet.json；动画不调用模型，不改变 YOLO 和中转设置。
  显卡或图形环境不支持 Live2D 时会显示兼容图像，并保留快捷聊天和任务状态。
  桌宠会在主界面加载后启动，沿用目录便携方式，不新增自解压或安装步骤。

这份定制目录中的 config 和个人 data 包含中转凭证，仅交给预期使用者。
这是独立客户端，不是 OpenAI 官方 Codex App。
已验证目录结构、真实 Electron 启动/图片对话、旧数据恢复和更新/回退逻辑。
当前构建验证环境为 Linux，Windows 原机的实际启动耗时仍需实测。
'''
(DEST / '使用说明.txt').write_text(readme, encoding='utf-8-sig')
(DEST / 'validation.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
files = sorted(p for p in DISTRIBUTION.rglob('*') if p.is_file())
assert not any(p.relative_to(DISTRIBUTION).parts[0] == 'data' for p in files)
hashes = []
for p in files:
    with p.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    hashes.append(digest + '  ' + p.relative_to(DISTRIBUTION).as_posix() + '\n')
(DEST / 'SHA256SUMS.txt').write_text(''.join(hashes), encoding='utf-8')
artifact = DEST / (FOLDER + '.zip')
with zipfile.ZipFile(artifact, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in files:
        z.write(p, FOLDER + '/' + p.relative_to(DISTRIBUTION).as_posix())
    z.writestr(FOLDER + '/data/', '')
    for name in ['使用说明.txt', 'SHA256SUMS.txt', 'validation.json']:
        z.write(DEST / name, FOLDER + '/' + name)

source = DEST / f'Codex-Portable-{VERSION}-source.zip'
with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name in ['package.json', 'package-lock.json', 'README.md', '.gitignore', '.prettierrc.json', '.prettierignore', 'LICENSE', 'THIRD_PARTY.md']:
        z.write(ROOT / name, 'codex-portable/' + name)
    for folder in ['src', 'assets', 'scripts', 'test', 'docs', '.github', 'browser-extension']:
        for p in (ROOT / folder).rglob('*'):
            if p.is_file() and '__pycache__' not in p.parts:
                z.write(p, 'codex-portable/' + p.relative_to(ROOT).as_posix())
    z.write(ROOT / 'config/provisioning.example.json', 'codex-portable/config/provisioning.example.json')
    for name in REPORTS:
        z.write(ROOT / 'test-output' / name / 'report.json', f'codex-portable/validation/{name}.json')
    for name in ['welcome.png', 'conversation.png', 'updates.png', 'profiles.png', 'clipboard.png', 'benchmark.png']:
        z.write(ROOT / 'test-output' / 'ui' / name, 'codex-portable/preview/' + name)
    for name in ['bongo.png', 'quick-chat.png', 'task-ready.png']:
        z.write(ROOT / 'test-output' / 'pet' / name, 'codex-portable/preview/pet-' + name)

with zipfile.ZipFile(source, 'a', compression=zipfile.ZIP_DEFLATED) as z:
    z.write(ROOT / 'test-output/usability-ui/result-card.png', 'codex-portable/preview/result-card.png')
    z.write(ROOT / 'test-output/novice/first-use.png', 'codex-portable/preview/first-use.png')

provision = json.loads((DISTRIBUTION / 'config' / 'provisioning.json').read_text())
keys = {p['apiKey'].encode() for p in [provision, *provision.get('profiles', [])] if p.get('apiKey')}
with zipfile.ZipFile(source) as z:
    for name in z.namelist():
        assert not any(key in z.read(name) for key in keys), 'Private credential in source archive'
for name in ['使用说明.txt', 'SHA256SUMS.txt', 'validation.json']:
    assert not any(key in (DEST / name).read_bytes() for key in keys)
for p in [artifact, source]:
    p.chmod(0o600)
    print(p, p.stat().st_size, 'bytes', flush=True)
print('Directory release complete; no user data or source credentials included', flush=True)
