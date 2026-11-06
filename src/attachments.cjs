'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
function imageThumbnail(image) {
  if (!image || image.isEmpty()) return undefined;
  return image.resize({ width: 76, height: 76, quality: 'good' }).toDataURL();
}
function storeImage(root, bytes, nativeImage, name = '截图') {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > MAX_IMAGE_BYTES
  )
    throw new Error('图片为空或超过 32 MB，请保存为文件后添加。');
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty())
    throw new Error('无法读取这张图片，请复制截图或 PNG/JPEG 图片后重试。');
  const dimensions = image.getSize();
  if (dimensions.width * dimensions.height > 60 * 1000 * 1000)
    throw new Error('图片尺寸过大，请先缩小后再添加。');
  const png = image.toPNG();
  if (!png.length || png.length > MAX_IMAGE_BYTES)
    throw new Error('图片转换后超过 32 MB，请保存为文件后添加。');
  const directory = path.join(root, 'attachments');
  fs.mkdirSync(directory, { recursive: true });
  const label =
    path
      .basename(String(name))
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 45) || '截图';
  const filename =
    label +
    '-' +
    new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-') +
    '-' +
    crypto.randomBytes(4).toString('hex') +
    '.png';
  const file = path.join(directory, filename);
  fs.writeFileSync(file, png, { flag: 'wx', mode: 0o600 });
  return {
    path: file,
    name: filename,
    size: png.length,
    image: true,
    thumbnail: imageThumbnail(image),
  };
}
async function clipboardImage(root, clipboard, nativeImage) {
  // Electron 45 uses async ClipboardItem/Blob instead of readImage().
  if (typeof clipboard.read === 'function') {
    for (const item of await clipboard.read()) {
      const type = item.types.includes('image/png')
        ? 'image/png'
        : item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > MAX_IMAGE_BYTES)
        throw new Error('图片超过 32 MB，请保存为文件后添加。');
      return storeImage(
        root,
        new Uint8Array(await blob.arrayBuffer()),
        nativeImage,
        '截图',
      );
    }
    return null;
  }
  if (typeof clipboard.readImage === 'function') {
    const image = clipboard.readImage();
    return image.isEmpty()
      ? null
      : storeImage(root, image.toPNG(), nativeImage, '截图');
  }
  throw new Error('当前运行环境无法读取剪贴板图片，请使用 Ctrl+V 或拖入图片。');
}
module.exports = {
  MAX_IMAGE_BYTES,
  imageThumbnail,
  storeImage,
  clipboardImage,
};
