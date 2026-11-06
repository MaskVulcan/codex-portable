"""Assemble a Windows payload with optional, explicitly supplied relay settings."""
from pathlib import Path
import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import ssl
import struct
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'downloads'
PAYLOAD = ROOT / 'payload'
CACHE.mkdir(exist_ok=True)
PAYLOAD.mkdir(exist_ok=True)
VERSION = '0.166.0'


def download(url, name):
    target = CACHE / name
    if target.exists() and target.stat().st_size > 1000:
        print('Cached:', name, flush=True)
        return target
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Codex-Portable-Build/1.0'})
            context = ssl.create_default_context(cafile=os.environ.get('CODEX_PORTABLE_CA_FILE'))
            with urllib.request.urlopen(request, timeout=60, context=context) as response, target.with_suffix('.part').open('wb') as f:
                shutil.copyfileobj(response, f)
            target.with_suffix('.part').replace(target)
            print('Downloaded:', name, target.stat().st_size, flush=True)
            return target
        except Exception as error:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def codex():
    archive = download(f'https://github.com/openai/codex/releases/download/rust-v{VERSION}/codex-package-x86_64-pc-windows-msvc.tar.gz', f'codex-{VERSION}-windows.tar.gz')
    destination = PAYLOAD / 'codex'
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as tf:
        for member in tf.getmembers():
            resolved = (destination / member.name).resolve()
            if not resolved.is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive entry')
        tf.extractall(destination, filter='data')
    candidates = list(destination.rglob('codex.exe'))
    print('Codex executable candidates:', [str(p.relative_to(destination)) for p in candidates], flush=True)
    license_file = download(f'https://raw.githubusercontent.com/openai/codex/rust-v{VERSION}/LICENSE', f'codex-{VERSION}-LICENSE.txt')
    (PAYLOAD / 'licenses').mkdir(exist_ok=True)
    shutil.copyfile(license_file, PAYLOAD / 'licenses' / 'CODEX-LICENSE.txt')


def python():
    archive = download('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', 'python-3.12.10-embed-amd64.zip')
    destination = PAYLOAD / 'python'
    destination.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(destination)
    (destination / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
    wheels = CACHE / 'wheels'
    wheels.mkdir(exist_ok=True)
    subprocess.run([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '312', '--implementation', 'cp', '--abi', 'cp312', '--dest', str(wheels), 'pip', 'setuptools', 'python-docx', 'PyMuPDF', 'Pillow', 'requests', 'beautifulsoup4', 'openpyxl', 'reportlab', 'pypdf', 'comtypes'], check=True)
    packages = destination / 'Lib' / 'site-packages'
    packages.mkdir(parents=True, exist_ok=True)
    for wheel in wheels.glob('*.whl'):
        with zipfile.ZipFile(wheel) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                parts = Path(info.filename).parts
                if parts[0].endswith('.data'):
                    if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
                        continue
                    parts = parts[2:]
                out = packages.joinpath(*parts)
                if not out.resolve().is_relative_to(packages.resolve()):
                    raise ValueError('Unsafe wheel entry')
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(info))
    print('Portable Python and', len(list(wheels.glob('*.whl'))), 'wheels ready', flush=True)


def provision(source=None):
    # Public builds use blank tokens. Never discover credentials from this machine.
    source = Path(source) if source else ROOT / 'config' / 'provisioning.example.json'
    settings = json.loads(source.read_text(encoding='utf-8-sig'))
    if not isinstance(settings, dict):
        raise ValueError('Provisioning must be a JSON object')
    profiles = settings.get('profiles')
    if not isinstance(profiles, list) or not profiles:
        raise ValueError('Provisioning needs at least one profile')
    ids = [profile.get('id') for profile in profiles if isinstance(profile, dict)]
    if len(ids) != len(profiles) or not all(isinstance(i, str) and i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('Profiles need distinct nonempty IDs')
    selected = next((p for p in profiles if p['id'] == settings.get('activeProfileId')), None)
    if not selected:
        raise ValueError('Active profile was not found')
    for profile in profiles:
        token = profile.get('apiKey', '')
        if not isinstance(token, str) or any(c.isspace() for c in token):
            raise ValueError('Invalid relay token')
        if not isinstance(profile.get('baseUrl'), str) or not profile['baseUrl'].startswith(('https://', 'http://')):
            raise ValueError('Invalid relay URL')
    settings.update(selected)
    p = PAYLOAD / 'provisioning.json'
    p.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
    p.chmod(0o600)
    print('Relay configuration prepared (tokens omitted)', flush=True)


def vc_runtime():
    """Copy Microsoft's redistributable DLLs app-locally; do not run an installer."""
    archive = download('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'vc_redist.x64.exe')
    seven = shutil.which('7zz') or shutil.which('7z')
    if not seven and os.name == 'nt':
        bundled = ROOT / 'node_modules' / '7zip-bin' / 'win' / 'x64' / '7za.exe'
        if bundled.exists():
            seven = str(bundled)
        else:
            raise RuntimeError('Run npm ci first or install 7-Zip and add it to PATH')
    if not seven:
        existing = list((Path.home() / '.cache' / 'electron-builder').glob('7zip*/**/7zz'))
        if existing:
            seven = str(existing[0])
        else:
            tool = download('https://www.7-zip.org/a/7z2409-linux-x64.tar.xz', '7z2409-linux-x64.tar.xz')
            dest = CACHE / 'seven'
            dest.mkdir(exist_ok=True)
            with tarfile.open(tool) as tf:
                tf.extractall(dest, filter='data')
            seven = str(dest / '7zz')
            Path(seven).chmod(0o755)
    dest = CACHE / 'vc-runtime'
    dest.mkdir(exist_ok=True)
    raw = archive.read_bytes()
    offset = 0
    count = 0
    while True:
        start = raw.find(b'MSCF\x00\x00\x00\x00', offset)
        if start < 0:
            break
        offset = start + 4
        size = struct.unpack_from('<I', raw, start+8)[0]
        if size < 36 or start + size > len(raw):
            continue
        cab = dest / f'container-{count}.cab'
        cab.write_bytes(raw[start:start+size])
        subprocess.run([seven, 'x', '-y', '-o'+str(dest / f'container-{count}'), str(cab)], check=True, stdout=subprocess.DEVNULL)
        count += 1
    for directory in list(dest.glob('container-*')):
        if not directory.is_dir():
            continue
        for file in directory.iterdir():
            with file.open('rb') as stream:
                magic = stream.read(8)
            if magic.startswith(b'MSCF') or magic.startswith(b'\xd0\xcf\x11\xe0'):
                subprocess.run([seven, 'x', '-y', '-o'+str(dest / ('extracted-'+file.name)), str(file)], check=True, stdout=subprocess.DEVNULL)
    copied = []
    for file in dest.rglob('*.dll_amd64'):
        if not file.name.lower().startswith(('msvcp140', 'vcruntime140', 'concrt140', 'vccorlib140', 'vcamp140')):
            continue
        raw = file.read_bytes()
        pe = struct.unpack_from('<I', raw, 0x3c)[0]
        if raw[pe:pe+4] != b'PE\0\0' or struct.unpack_from('<H', raw, pe+4)[0] != 0x8664:
            continue
        name = file.name.removesuffix('_amd64')
        shutil.copyfile(file, PAYLOAD / 'python' / name)
        copied.append(name)
    if 'msvcp140.dll' not in copied:
        raise RuntimeError('Microsoft C++ runtime missing')
    (PAYLOAD / 'python' / 'VC-REDISTRIBUTABLE-NOTICE.txt').write_text('Microsoft Visual C++ 2015-2022 Redistributable (x64), app-local runtime files.\nSource: https://aka.ms/vs/17/release/vc_redist.x64.exe\nLicensing: https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/\nThese files remain copyright Microsoft Corporation.\n', encoding='utf-8')
    (PAYLOAD / 'licenses').mkdir(exist_ok=True)
    for name in ['u4', 'u6']:
        license_file = dest / 'container-0' / name
        if license_file.exists() and license_file.read_bytes().startswith(b'{\\rtf'):
            shutil.copyfile(license_file, PAYLOAD / 'licenses' / ('Microsoft-VC-runtime-' + name + '.rtf'))
    print('App-local Microsoft runtime DLLs ready:', len(copied), flush=True)


def manifest():
    app_version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    (PAYLOAD / 'layout.json').write_text(json.dumps({'layoutVersion': 2, 'appVersion': app_version, 'codexVersion': VERSION}, indent=2), encoding='utf-8')
    files = {}
    for p in PAYLOAD.rglob('*'):
        if p.is_file() and p.name != 'manifest.json':
            files[str(p.relative_to(PAYLOAD))] = {'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    (PAYLOAD / 'manifest.json').write_text(json.dumps({'version': app_version, 'codexVersion': VERSION, 'files': files}, indent=2), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provisioning', type=Path, help='Optional private JSON; defaults to the token-free example')
    args = parser.parse_args()
    provision(args.provisioning)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(codex), pool.submit(python)]
        for task in tasks:
            task.result()
    vc_runtime()
    manifest()
    print('Payload complete', flush=True)
