'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  storeImage,
  MAX_IMAGE_BYTES,
  clipboardImage,
} = require('../src/attachments.cjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAHElEQVR4nGNUL09noAZgooopowaNGjRq0Ag2CADyUgElcJ4OpQAAAABJRU5ErkJggg==',
  'base64',
);
const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 1, height: 1 }),
  toPNG: () => png,
  resize() {
    return this;
  },
  toDataURL: () => 'data:image/png;base64,' + png.toString('base64'),
};
test('pathless clipboard images become durable PNG attachments with thumbnails and unique names', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = { createFromBuffer: () => image };
  const a = storeImage(dir, new Uint8Array(png), native, 'clipboard.png'),
    b = storeImage(dir, new Uint8Array(png), native, 'clipboard.png');
  assert.notEqual(a.path, b.path);
  assert.ok(a.path.startsWith(path.join(dir, 'attachments')));
  assert.deepEqual(fs.readFileSync(a.path), png);
  assert.ok(a.image);
  assert.match(a.thumbnail, /^data:image\/png;base64,/);
  assert.ok(fs.existsSync(b.path));
});
test('empty, excessive and undecodable clipboard images fail before writing files', () => {
  const native = { createFromBuffer: () => ({ isEmpty: () => true }) };
  assert.throws(() => storeImage('/unused', new Uint8Array(), native), /为空/);
  assert.throws(
    () => storeImage('/unused', new Uint8Array(MAX_IMAGE_BYTES + 1), native),
    /32 MB/,
  );
  assert.throws(
    () => storeImage('/unused', new Uint8Array([1]), native),
    /无法读取/,
  );
});
test('Electron 45 async ClipboardItem and Blob API is supported without readImage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-async-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clipboard = {
    read: async () => [
      {
        types: ['image/png'],
        getType: async () => new Blob([png], { type: 'image/png' }),
      },
    ],
  };
  const file = await clipboardImage(dir, clipboard, {
    createFromBuffer: () => image,
  });
  assert.ok(file.image);
  assert.deepEqual(fs.readFileSync(file.path), png);
  assert.equal(
    await clipboardImage(
      dir,
      { read: async () => [{ types: ['text/plain'] }] },
      { createFromBuffer: () => image },
    ),
    null,
  );
});
