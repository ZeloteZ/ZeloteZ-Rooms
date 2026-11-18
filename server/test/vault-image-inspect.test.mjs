import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
const { inspectVaultImage, decodeVaultImage, VAULT_IMAGE_DECODE_BYTES } = await import('../../web/vault-image-inspect.js');
const { VAULT_EDITOR_LIMITS } = await import('../../web/vault-media-edit.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (name, ...body) => { const b = Buffer.concat(body); return Buffer.concat([u32(b.length + 8), Buffer.from(name), b]); };
const avifMeta = (width = 16, height = 12) => box('meta', u32(0), box('pitm', u32(0), Buffer.from([0, 1])),
  box('iprp', box('ipco', box('ispe', u32(0), u32(width), u32(height))), box('ipma', u32(0), u32(1), Buffer.from([0, 1, 1, 0x81]))));
const ftyp = box('ftyp', Buffer.from('avif'), u32(0), Buffer.from('avifmif1'));

class SparseImage extends Blob {
  constructor(size, segments) { super([]); this.length = size; this.segments = segments; this.reads = []; }
  get size() { return this.length; }
  arrayBuffer() { throw new Error('the complete image must never enter a JavaScript buffer'); }
  slice(start = 0, end = this.size) {
    this.reads.push([start, end]);
    assert.ok(end - start <= 4 * 1024 ** 2);
    const result = Buffer.alloc(end - start);
    for (const [offset, bytes] of this.segments) {
      const first = Math.max(start, offset), last = Math.min(end, offset + bytes.length);
      if (last > first) bytes.copy(result, first - start, first - offset, last - offset);
    }
    return new Blob([result]);
  }
}

test('10GiB image input reads bounded headers and keeps the decoded pixel limit separate', async () => {
  assert.equal(VAULT_EDITOR_LIMITS.mediaBytes, 10 * 1024 ** 3);
  const image = new SparseImage(VAULT_EDITOR_LIMITS.mediaBytes, [[0, png]]);
  assert.deepEqual(await inspectVaultImage(image), { type: 'image/png', width: 1, height: 1 });
  assert.equal(image.reads.length, 1);
  assert.equal(image.reads[0][1], 4096);
  await assert.rejects(inspectVaultImage(new SparseImage(image.size + 1, [[0, png]])), /dimension metadata/);
  for (const [width, height] of [[100000, 100000], [0, 20], [1, 0xffffffff]]) {
    const bytes = Buffer.from(png); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    await assert.rejects(inspectVaultImage(new Blob([bytes])), /resolution limit/);
  }
});

test('JPEG marker scanning skips metadata payload and rejects bombs before decoder use', async () => {
  const metadata = Buffer.alloc(65535); metadata[0] = 0xff; metadata[1] = 0xe1; metadata.writeUInt16BE(metadata.length - 2, 2);
  const frame = Buffer.from([0xff, 0xc2, 0, 17, 8, 0, 12, 0, 16, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const image = new SparseImage(10 * 1024 ** 3, [[0, Buffer.from([0xff, 0xd8])], [2, metadata], [2 + metadata.length, frame]]);
  assert.deepEqual(await inspectVaultImage(image), { type: 'image/jpeg', width: 16, height: 12 });
  assert.ok(image.reads.reduce((n, [start, end]) => n + end - start, 0) < 5000);
  const bomb = Buffer.from(frame); bomb.writeUInt16BE(65535, 5); bomb.writeUInt16BE(65535, 7);
  await assert.rejects(inspectVaultImage(new Blob([Buffer.from([0xff, 0xd8]), bomb])), /resolution limit/);
  await assert.rejects(inspectVaultImage(new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])])), /dimension metadata/);
});

test('AVIF locates primary item dimensions after a10GiB data box without reading its payload', async () => {
  const size = VAULT_EDITOR_LIMITS.mediaBytes, meta = avifMeta();
  const mdat = Buffer.alloc(16); mdat.writeUInt32BE(1); mdat.write('mdat', 4); mdat.writeBigUInt64BE(BigInt(size - ftyp.length - meta.length), 8);
  const image = new SparseImage(size, [[0, ftyp], [ftyp.length, mdat], [size - meta.length, meta]]);
  assert.deepEqual(await inspectVaultImage(image), { type: 'image/avif', width: 16, height: 12 });
  assert.ok(image.reads.every(([start, end]) => end - start <= 4096));
  await assert.rejects(inspectVaultImage(new Blob([ftyp, avifMeta(100000, 100000)])), /resolution limit/);
  const missingPrimary = avifMeta(); missingPrimary[missingPrimary.length - 1] = 0;
  await assert.rejects(inspectVaultImage(new Blob([ftyp, missingPrimary])), /dimension metadata/);
  const broken = Buffer.from(ftyp); broken.writeUInt32BE(7);
  await assert.rejects(inspectVaultImage(new Blob([broken, meta])), /dimension metadata/);
});

test('GIF, BMP and WebP dimensions are bounded before native decoding; malformed ranges fail closed', async () => {
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(16, 6); gif.writeUInt16LE(12, 8);
  const bmp = Buffer.alloc(54); bmp.write('BM'); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(16, 18); bmp.writeInt32LE(-12, 22);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp[24] = 15; webp[27] = 11;
  for (const [bytes, type] of [[gif, 'image/gif'], [bmp, 'image/bmp'], [webp, 'image/webp']]) assert.deepEqual(await inspectVaultImage(new Blob([bytes])), { type, width: 16, height: 12 });
  gif.writeUInt16LE(65535, 6); gif.writeUInt16LE(65535, 8);
  bmp.writeInt32LE(100000, 18); bmp.writeInt32LE(100000, 22);
  webp.fill(255, 24, 30);
  for (const bytes of [gif, bmp, webp]) await assert.rejects(inspectVaultImage(new Blob([bytes])), /resolution limit/);
  await assert.rejects(inspectVaultImage(new Blob([png.subarray(0, 25)])), /dimension metadata/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectVaultImage(new Blob([png]), { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(inspectVaultImage(new Blob(['<svg onload="alert(1)">'])), /supported raster image/);
});

function replaceGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function frame(width = 1, height = 1) {
  return { displayWidth: width, displayHeight: height, closed: 0, close() { this.closed++; } };
}
function bitmap() { return { closed: 0, close() { this.closed++; } }; }

test('the streamed image path decodes only frame zero, closes its VideoFrame and leaves the returned bitmap owned by the caller', async t => {
  const decoded = frame(), output = bitmap(), instances = [], calls = [];
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported(type) { assert.equal(type, 'image/png'); return true; }
    constructor(options) { this.options = options; this.closed = 0; instances.push(this); }
    async decode(options) {
      calls.push(options);
      this.reader = this.options.data.getReader();
      const { value } = await this.reader.read();
      assert.ok(value.byteLength <= 256 * 1024);
      assert.equal(value[0], 137); value.fill(0);
      return { image: decoded };
    }
    close() { this.closed++; void this.reader?.cancel().catch(() => {}); }
  });
  replaceGlobal(t, 'createImageBitmap', async value => { assert.equal(value, decoded); return output; });
  assert.equal(await decodeVaultImage(new Blob([png])), output);
  assert.deepEqual(calls, [{ frameIndex: 0, completeFramesOnly: true }]);
  assert.equal(instances[0].options.preferAnimation, false);
  assert.equal(instances[0].closed, 1);
  assert.equal(decoded.closed, 1); assert.equal(output.closed, 0);
  output.close();
});

test('cancelling a pending decoder closes a late VideoFrame before any bitmap can be created', async t => {
  const controller = new AbortController(), decoded = frame();
  let ready, finish, decoder, bitmapCalls = 0;
  const started = new Promise(resolve => { ready = resolve; });
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported() { return true; }
    constructor() { this.closed = 0; decoder = this; }
    decode() { ready(); return new Promise(resolve => { finish = resolve; }); }
    close() { this.closed++; }
  });
  replaceGlobal(t, 'createImageBitmap', async () => { bitmapCalls++; return bitmap(); });
  const operation = decodeVaultImage(new Blob([png]), { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  finish({ image: decoded }); await tick();
  assert.equal(decoder.closed, 1); assert.equal(decoded.closed, 1); assert.equal(bitmapCalls, 0);
});

test('cancellation wipes a late streamed input read and never delivers its bytes to the decoder', async t => {
  const controller = new AbortController(), source = new SparseImage(10 * 1024 ** 3, [[0, png]]);
  let release, announce, returned, reader, readerFailed;
  const reading = new Promise(resolve => { announce = resolve; });
  const original = source.slice.bind(source);
  source.slice = (start, end) => {
    if (end - start <= 4096) return original(start, end);
    return { arrayBuffer() { announce(); return new Promise(resolve => { release = () => {
      returned = new Uint8Array(end - start).fill(77); resolve(returned.buffer);
    }; }); } };
  };
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported() { return true; }
    constructor(options) { reader = options.data.getReader(); }
    decode() { return reader.read().then(() => { throw new Error('cancelled bytes must not produce a frame'); }); }
    close() { readerFailed = reader.cancel().catch(() => {}); }
  });
  replaceGlobal(t, 'createImageBitmap', () => { throw new Error('must not create a bitmap'); });
  const operation = decodeVaultImage(source, { signal: controller.signal });
  await reading; controller.abort(); await assert.rejects(operation, { name: 'AbortError' });
  release(); await tick(); await readerFailed;
  assert.ok(returned.every(byte => byte === 0));
});

test('late bitmaps are closed on cancellation in both streaming and small-file fallback paths', async t => {
  for (const streaming of [true, false]) await t.test(streaming ? 'streaming' : 'fallback', async subtest => {
    const controller = new AbortController(), decoded = frame(), output = bitmap();
    let announce, finish;
    const started = new Promise(resolve => { announce = resolve; });
    replaceGlobal(subtest, 'ImageDecoder', class {
      static async isTypeSupported() { return streaming; }
      async decode() { return { image: decoded }; }
      close() {}
    });
    replaceGlobal(subtest, 'createImageBitmap', input => {
      if (streaming) assert.equal(input, decoded);
      else { assert.ok(input instanceof Blob); assert.equal(input.size, png.length); assert.equal(input.type, 'image/png'); }
      announce(); return new Promise(resolve => { finish = resolve; });
    });
    const operation = decodeVaultImage(new Blob([png]), { signal: controller.signal });
    await started; controller.abort(); await assert.rejects(operation, { name: 'AbortError' });
    finish(output); await tick();
    assert.equal(output.closed, 1);
    assert.equal(decoded.closed, streaming ? 1 : 0);
  });
});

test('unsupported streaming decoders allow only bounded small-file fallback, with no large native bitmap request', async t => {
  let bitmapCalls = 0, decoders = 0;
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported() { return false; }
    constructor() { decoders++; }
  });
  replaceGlobal(t, 'createImageBitmap', async () => { bitmapCalls++; return bitmap(); });
  const small = await decodeVaultImage(new Blob([png])); small.close();
  assert.equal(bitmapCalls, 1); assert.equal(decoders, 0);
  await assert.rejects(decodeVaultImage(new SparseImage(VAULT_EDITOR_LIMITS.inputBytes + 1, [[0, png]])), /decoding safety limit/u);
  assert.equal(bitmapCalls, 1, 'large unsupported formats must never fall back to a full native Blob decode');
});

test('browsers without a streaming image API keep the same 128MiB fallback boundary', async t => {
  let calls = 0;
  replaceGlobal(t, 'ImageDecoder', undefined);
  replaceGlobal(t, 'createImageBitmap', async () => { calls++; return bitmap(); });
  const image = await decodeVaultImage(new Blob([png])); image.close();
  await assert.rejects(decodeVaultImage(new SparseImage(VAULT_EDITOR_LIMITS.inputBytes + 1, [[0, png]])), /decoding safety limit/u);
  assert.equal(calls, 1);
});

test('oversized actual VideoFrame dimensions are rejected and closed before bitmap allocation', async t => {
  const decoded = frame(100000, 100000);
  let bitmapCalls = 0;
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported() { return true; }
    async decode() { return { image: decoded }; }
    close() {}
  });
  replaceGlobal(t, 'createImageBitmap', async () => { bitmapCalls++; return bitmap(); });
  await assert.rejects(decodeVaultImage(new Blob([png])), /resolution limit/u);
  assert.equal(decoded.closed, 1); assert.equal(bitmapCalls, 0);
});

test('a decoder that keeps requesting source data is stopped at the compressed first-frame budget', async t => {
  assert.equal(VAULT_IMAGE_DECODE_BYTES, 512 * 1024 ** 2);
  const source = new SparseImage(10 * 1024 ** 3, [[0, png]]);
  replaceGlobal(t, 'ImageDecoder', class {
    static async isTypeSupported() { return true; }
    constructor(options) { this.reader = options.data.getReader(); }
    async decode() {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) throw new Error('source must hit its safety limit before EOF');
        value.fill(0);
      }
    }
    close() { void this.reader.cancel().catch(() => {}); }
  });
  replaceGlobal(t, 'createImageBitmap', () => { throw new Error('must not create a bitmap'); });
  await assert.rejects(decodeVaultImage(source), /decoding safety limit/u);
  const streamed = source.reads.filter(([start, end]) => end - start > 4096);
  assert.equal(streamed.reduce((sum, [start, end]) => sum + end - start, 0), VAULT_IMAGE_DECODE_BYTES);
  assert.ok(streamed.every(([start, end]) => end - start <= 256 * 1024 && end <= VAULT_IMAGE_DECODE_BYTES));
});
