"""Prepare the small BongoCat model and browser renderer for offline use."""
from pathlib import Path
import concurrent.futures
import hashlib
import json
import shutil
import sys
sys.path.insert(0, str(Path(__file__).parent))
from prepare import download

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'pet-assets'
MODEL = ASSETS / 'bongo'
VENDOR = ROOT / 'assets' / 'pet-vendor'
MODEL.mkdir(parents=True, exist_ok=True)
VENDOR.mkdir(parents=True, exist_ok=True)
BASE = 'https://raw.githubusercontent.com/ayangweb/BongoCat/v2.4.1/resources/models/standard/'
FILES = ['cat.model3.json', 'demomodel.moc3', 'demomodel.cdi3.json',
         'demomodel.1024/texture_00.png', 'demomodel.1024/texture_01.png', 'demomodel.1024/texture_02.png',
         'live2d_expression0.exp3.json', 'live2d_expression1.exp3.json', 'live2d_expression2.exp3.json',
         'live2d_motion1.motion3.json', 'live2d_motion2.motion3.json',
         'resources/cover.png', 'resources/background.png']


def model_file(name):
    cached = download(BASE + name, 'pet-bongo-' + name.replace('/', '-'))
    target = MODEL / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(cached, target)


with concurrent.futures.ThreadPoolExecutor(4) as pool:
    list(pool.map(model_file, FILES))
# Mute bundled motion sounds. They are optional and not needed for task feedback.
manifest = json.loads((MODEL / 'cat.model3.json').read_text())
for motions in manifest['FileReferences'].get('Motions', {}).values():
    for motion in motions:
        motion.pop('Sound', None)
(MODEL / 'cat.model3.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

core = download('https://raw.githubusercontent.com/Open-LLM-VTuber/Open-LLM-VTuber-Web/main/src/renderer/WebSDK/Core/live2dcubismcore.min.js', 'pet-live2dcubismcore.min.js')
shutil.copyfile(core, VENDOR / 'live2dcubismcore.min.js')
for source, target in [
    ('node_modules/pixi.js/dist/browser/pixi.min.js', 'pixi.min.js'),
    ('node_modules/@pixi/unsafe-eval/dist/browser/unsafe-eval.min.js', 'unsafe-eval.min.js'),
    ('node_modules/pixi-live2d-display/dist/cubism4.min.js', 'cubism4.min.js'),
]:
    p = ROOT / source
    if not p.exists():
        raise RuntimeError('Install dev renderer packages first: ' + source)
    shutil.copyfile(p, VENDOR / target)

notice = '''Desktop pet components and attribution

BongoCat default model / textures: ayangweb/BongoCat v2.4.1
https://github.com/ayangweb/BongoCat/tree/v2.4.1/resources/models/standard
Original model inspiration: MMmmmoko/Bongo-Cat-Mver
https://github.com/MMmmmoko/Bongo-Cat-Mver

pixi.js 6.5.10 (MIT), pixi-live2d-display 0.4.0 (MIT).
Live2D Cubism Core: copyright Live2D Inc.; proprietary redistributable code.
The Core source header retains its original license notice and URL.
Core copy source: Open-LLM-VTuber/Open-LLM-VTuber-Web.

The companion interface, task integration and window controller are original
components of this portable assistant. Artwork, Core and other third-party
components retain their own copyrights and terms.
'''
(ASSETS / 'NOTICE.txt').write_text(notice, encoding='utf-8')
for folder, name in [('pixi.js', 'PIXI-LICENSE.txt'), ('pixi-live2d-display', 'PIXI-LIVE2D-LICENSE.txt')]:
    package = ROOT / 'node_modules' / folder
    license_file = next((p for p in package.iterdir() if p.name.lower() in ('license', 'license.txt', 'license.md')), None)
    if license_file:
        shutil.copyfile(license_file, ASSETS / name)
files = {}
for prefix, directory in [('pets', ASSETS), ('vendor', VENDOR)]:
    for p in directory.rglob('*'):
        if p.is_file() and p.name != 'manifest.json':
            files[prefix + '/' + p.relative_to(directory).as_posix()] = {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
(ASSETS / 'manifest.json').write_text(json.dumps({'model': 'BongoCat v2.4.1 standard', 'files': files}, indent=2), encoding='utf-8')
print('Offline pet assets bytes:', sum(v['bytes'] for v in files.values()))
