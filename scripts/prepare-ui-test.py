from pathlib import Path
import concurrent.futures
import io
import shutil
import tarfile
import sys
sys.path.insert(0, str(Path(__file__).parent))
from prepare import download

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'test-output' / 'linuxlibs'
DEST.mkdir(parents=True, exist_ok=True)


def deb(url):
    p = download(url, url.rsplit('/', 1)[-1])
    raw = p.read_bytes()
    assert raw[:8] == b'!<arch>\n'
    offset = 8
    while offset + 60 <= len(raw):
        name = raw[offset:offset+16].decode().strip().rstrip('/')
        size = int(raw[offset+48:offset+58].decode().strip())
        payload = raw[offset+60:offset+60+size]
        if name.startswith('data.tar'):
            with tarfile.open(fileobj=io.BytesIO(payload)) as tf:
                for m in tf.getmembers():
                    if m.isfile() and '.so' in Path(m.name).name:
                        (DEST / Path(m.name).name).write_bytes(tf.extractfile(m).read())
                for m in tf.getmembers():
                    if m.issym() and '.so' in Path(m.name).name:
                        link = DEST / Path(m.name).name
                        if not link.exists():
                            link.symlink_to(Path(m.linkname).name)
            return
        offset += 60 + size + size % 2
    raise ValueError('Missing data archive')


urls = [
    'https://archive.ubuntu.com/ubuntu/pool/main/n/nss/libnss3_3.98-0ubuntu0.20.04.2_amd64.deb',
    'https://archive.ubuntu.com/ubuntu/pool/main/n/nspr/libnspr4_4.35-0ubuntu0.20.04.1_amd64.deb',
    'https://archive.ubuntu.com/ubuntu/pool/main/m/mesa/libgbm1_21.2.6-0ubuntu0.1~20.04.2_amd64.deb',
]
with concurrent.futures.ThreadPoolExecutor(3) as pool:
    list(pool.map(deb, urls))
font = download('https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf', 'NotoSansCJKsc-Regular.otf')
fonts = ROOT / 'test-output' / 'fonts'
fonts.mkdir(exist_ok=True)
shutil.copyfile(font, fonts / font.name)
config = ROOT / 'test-output' / 'fontconfig.xml'
config.write_text(f'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>{fonts}</dir><dir>/usr/share/fonts</dir><cachedir>{ROOT / "test-output" / "fontcache"}</cachedir></fontconfig>')
print('Local UI test dependencies ready (no system installation)')
