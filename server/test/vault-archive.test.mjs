import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as zlib from 'node:zlib';
import test from 'node:test';
import { openVaultArchive, writeVaultZip } from '../../web/vault-archive.js';

const text = new TextDecoder();
const encoded = value => new TextEncoder().encode(value);
const crc = bytes => {
  if (zlib.crc32) return zlib.crc32(bytes);
  let result = 0xffffffff;
  for (const byte of bytes) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ result >>> 1 : result >>> 1; }
  return (result ^ 0xffffffff) >>> 0;
};
const blob = bytes => new Blob([bytes]);
function runPython(source, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', source], { encoding: null, maxBuffer: 64 * 1024 ** 2, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
}
function zipFixture(input, { method = 0, descriptor = false, declaredSize, flags = 0x800 } = {}) {
  const local = [], central = []; let cursor = 0;
  for (const item of input) {
    const name = typeof item.name === 'string' ? encoded(item.name) : item.name;
    const data = typeof item.data === 'string' ? encoded(item.data) : item.data ?? new Uint8Array();
    const payload = method === 8 ? zlib.deflateRawSync(data) : data;
    const expanded = declaredSize ?? data.length, checksum = crc(data), bits = flags | (descriptor ? 8 : 0);
    const extra = item.extra ?? new Uint8Array();
    const header = Buffer.alloc(30 + name.length + extra.length), record = Buffer.alloc(46 + name.length + extra.length);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(bits, 6); header.writeUInt16LE(method, 8);
    if (!descriptor) { header.writeUInt32LE(checksum, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(expanded, 22); }
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28); header.set(name, 30); header.set(extra, 30 + name.length);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(bits, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(payload.length, 20); record.writeUInt32LE(expanded, 24); record.writeUInt16LE(name.length, 28); record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(item.attributes ?? ((item.name.endsWith?.('/') ? 0o40755 : 0o100600) << 16) >>> 0, 38); record.writeUInt32LE(cursor, 42); record.set(name, 46); record.set(extra, 46 + name.length);
    local.push(header, payload); central.push(record); cursor += header.length + payload.length;
    if (descriptor) { const trailer = Buffer.alloc(16); trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(checksum, 4); trailer.writeUInt32LE(payload.length, 8); trailer.writeUInt32LE(expanded, 12); local.push(trailer); cursor += 16; }
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(input.length, 8); end.writeUInt16LE(input.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(cursor, 16);
  return Buffer.concat([...local, directory, end]);
}
function pythonArchive(kind, entries, options = {}) {
  const source = `import base64,io,json,sys,tarfile,zipfile,warnings
warnings.simplefilter('ignore')
request=json.load(sys.stdin);output=io.BytesIO()
if request['kind']=='zip':
 class Stream(io.BytesIO):
  def seek(self,*args): raise io.UnsupportedOperation()
 if request['options'].get('descriptor'): output=Stream()
 with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED if request['options'].get('deflate') else zipfile.ZIP_STORED) as archive:
  for item in request['entries']: archive.writestr(item['name'],item.get('data',''))
else:
 formats={'ustar':tarfile.USTAR_FORMAT,'pax':tarfile.PAX_FORMAT,'gnu':tarfile.GNU_FORMAT}
 with tarfile.open(fileobj=output,mode='w',format=formats[request['options'].get('format','pax')]) as archive:
  for item in request['entries']:
   header=tarfile.TarInfo(item['name']);data=item.get('data','').encode();header.size=len(data)
   if item.get('directory'):header.type=tarfile.DIRTYPE;header.size=0
   if item.get('link'):header.type=tarfile.SYMTYPE;header.linkname=item['link'];header.size=0
   if item.get('hardlink'):header.type=tarfile.LNKTYPE;header.linkname=item['hardlink'];header.size=0
   if item.get('pax'):header.pax_headers=item['pax']
   archive.addfile(header,io.BytesIO(data))
sys.stdout.buffer.write(output.getvalue())`;
  return runPython(source, JSON.stringify({ kind, entries, options }));
}
class BrowserWorker {
  constructor(url) {
    const wrapper = `import {parentPort,workerData} from 'node:worker_threads';globalThis.self={postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};await import(workerData);parentPort.on('message',data=>self.onmessage({data}));`;
    this.thread = new ThreadWorker(new URL('data:text/javascript,' + encodeURIComponent(wrapper)), { workerData: url.href });
    this.thread.on('message', data => this.onmessage?.({ data }));
    this.thread.on('error', error => this.onerror?.(error));
  }
  postMessage(value, transfer) { this.thread.postMessage(value, transfer); }
  terminate() { return this.thread.terminate(); }
}
globalThis.Worker = BrowserWorker;

test('fresh UTF-8 ZIPs roundtrip Office XML, binary files, directories and zero-byte files', async () => {
  const input = new Uint8Array([0, 255, 1]);
  const result = await writeVaultZip([{ name: 'word/document.xml', data: '<doc>Grüße 文件</doc>' }, { name: 'Bilder/', kind: 'directory' },
    { name: 'Bilder/Bild.bin', data: input }, { name: 'empty', data: '' }]);
  assert.equal(result.type, 'application/zip'); assert.deepEqual(input, new Uint8Array([0, 255, 1]));
  const archive = await openVaultArchive(result);
  try {
    assert.equal(archive.format, 'zip'); assert.ok(Object.isFrozen(archive.entries));
    assert.equal(text.decode(await archive.read('word/document.xml')), '<doc>Grüße 文件</doc>');
    assert.deepEqual(await archive.read(archive.entries[2]), input);
    assert.equal((await archive.read('empty')).length, 0);
    await assert.rejects(archive.read('Bilder'));
    const read = (await runPython("import io,sys,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None;print(z.read('word/document.xml').decode())", Buffer.from(await result.arrayBuffer()))).toString().trim();
    assert.equal(read, '<doc>Grüße 文件</doc>');
  } finally { archive.close(); }
});

for (const method of [0, 8]) for (const descriptor of [false, true]) {
  test(`real Python ZIP files support method ${method} and data descriptors ${descriptor}`, async () => {
    const bytes = await pythonArchive('zip', [{ name: 'Ordner/Datei 文件.txt', data: 'safe original text' }, { name: 'empty', data: '' }], { deflate: method === 8, descriptor });
    const archive = await openVaultArchive(blob(bytes));
    try { assert.equal(text.decode(await archive.read('Ordner/Datei 文件.txt')), 'safe original text'); assert.equal((await archive.read('empty')).length, 0); }
    finally { archive.close(); }
  });
}

test('CP437 names are decoded without losing non-ASCII bytes', async () => {
  const archive = await openVaultArchive(blob(zipFixture([{ name: new Uint8Array([0x82, 46, 116, 120, 116]), data: 'original' }], { flags: 0 })));
  try { assert.equal(archive.entries[0].path, 'é.txt'); assert.equal(text.decode(await archive.read('é.txt')), 'original'); }
  finally { archive.close(); }
});

test('ZIP CRC mismatches are detected before plaintext is returned', async () => {
  const bytes = zipFixture([{ name: 'file.txt', data: 'original' }]); bytes[30 + encoded('file.txt').length] ^= 1;
  const archive = await openVaultArchive(blob(bytes));
  try { await assert.rejects(archive.read('file.txt'), { code: 'VAULT_ARCHIVE_INVALID' }); }
  finally { archive.close(); }
});

test('ZIP local-header name, size and method mismatches are rejected before extraction', async () => {
  for (const mutate of [bytes => { bytes[30] ^= 1; }, bytes => { bytes.writeUInt32LE(99, 22); }, bytes => { bytes.writeUInt16LE(8, 8); }]) {
    const bytes = zipFixture([{ name: 'file.txt', data: 'original' }]); mutate(bytes);
    await assert.rejects(openVaultArchive(blob(bytes)), { code: 'VAULT_ARCHIVE_INVALID' });
  }
});

test('ZIP encryption, Zip64, symlinks, hardlink metadata and special files are refused', async () => {
  const encrypted = zipFixture([{ name: 'file', data: 'x' }], { flags: 0x801 });
  await assert.rejects(openVaultArchive(blob(encrypted)), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  const zip64 = zipFixture([{ name: 'file', data: 'x' }]); zip64.writeUInt16LE(0xffff, zip64.length - 14); zip64.writeUInt16LE(0xffff, zip64.length - 12);
  await assert.rejects(openVaultArchive(blob(zip64)), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  for (const mode of [0o120777, 0o010600, 0o020600]) {
    await assert.rejects(openVaultArchive(blob(zipFixture([{ name: 'link', data: 'target', attributes: (mode << 16) >>> 0 }]))), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  }
});

test('ZIP traversal, aliases, hidden controls, collisions and file-directory conflicts are rejected', async () => {
  for (const name of ['../escape', '/absolute', 'C:/file', 'C:relative', './C:/file', './http:resource', 'a\\b', 'a/../b', 'a//b', 'a/./b', 'http:resource', 'hidden\u202e.txt']) {
    await assert.rejects(openVaultArchive(blob(zipFixture([{ name, data: 'x' }]))), { code: 'VAULT_ARCHIVE_INVALID' });
  }
  for (const names of [['file', './file'], ['A.txt', 'a.txt'], ['é.txt', 'e\u0301.txt'], ['file', 'file/child']]) {
    await assert.rejects(openVaultArchive(blob(zipFixture(names.map(name => ({ name, data: 'x' }))))), { code: 'VAULT_ARCHIVE_INVALID' });
  }
  const nul = zipFixture([{ name: new Uint8Array([97, 0, 98]), data: 'x' }]);
  await assert.rejects(openVaultArchive(blob(nul)), { code: 'VAULT_ARCHIVE_INVALID' });
});

test('ZIP duplicate offsets, overlapping ranges and unreferenced hidden data are rejected', async () => {
  const bytes = zipFixture([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }]);
  const central = bytes.readUInt32LE(bytes.length - 6); bytes.writeUInt32LE(0, central + 47 + 42);
  await assert.rejects(openVaultArchive(blob(bytes)), { code: 'VAULT_ARCHIVE_INVALID' });
  const trailing = Buffer.concat([zipFixture([{ name: 'a', data: 'x' }]), Buffer.from('hidden')]);
  await assert.rejects(openVaultArchive(blob(trailing)), { code: 'VAULT_ARCHIVE_INVALID' });
});

test('actual DEFLATE output is bounded independently of dishonest size declarations', async () => {
  const bomb = zipFixture([{ name: 'bomb', data: Buffer.alloc(8 * 1024 ** 2, 65) }], { method: 8, declaredSize: 1 });
  const archive = await openVaultArchive(blob(bomb), { limits: { entryBytes: 1024, expandedBytes: 1024 } });
  try { await assert.rejects(archive.read('bomb'), { code: 'VAULT_ARCHIVE_LIMIT' }); }
  finally { archive.close(); }
});

test('input, entry, total expansion, metadata, count and caller read limits are enforced', async () => {
  const bytes = zipFixture([{ name: 'a', data: '1234' }, { name: 'b', data: '5678' }]);
  for (const limits of [{ inputBytes: 10 }, { expandedBytes: 7 }, { metadataBytes: 10 }, { entries: 1 }]) {
    await assert.rejects(openVaultArchive(blob(bytes), { limits }), { code: 'VAULT_ARCHIVE_LIMIT' });
  }
  const archive = await openVaultArchive(blob(bytes), { limits: { expandedBytes: 8 } });
  try {
    await assert.rejects(archive.read('a', { maxBytes: 3 }), { code: 'VAULT_ARCHIVE_LIMIT' });
    await archive.read('a'); await archive.read('b');
    await assert.rejects(archive.read('a'), { code: 'VAULT_ARCHIVE_LIMIT' });
  } finally { archive.close(); }
});

for (const format of ['ustar', 'pax', 'gnu']) {
  test(`real Python ${format} TAR archives preserve regular files and directories`, async () => {
    const name = format === 'ustar' ? 'directory/file.txt' : 'directory/' + 'long-'.repeat(30) + '文件.txt';
    const archive = await openVaultArchive(blob(await pythonArchive('tar', [{ name: './', directory: true }, { name: 'directory/', directory: true }, { name, data: 'Grüße 文件' }], { format })));
    try { assert.equal(archive.format, 'tar'); assert.equal(text.decode(await archive.read(name)), 'Grüße 文件'); }
    finally { archive.close(); }
  });
}

test('TAR PAX Unicode paths and leading-dot normalization remain safe and unambiguous', async () => {
  const archive = await openVaultArchive(blob(await pythonArchive('tar', [{ name: './Datei 文件.txt', data: 'original' }])));
  try { assert.equal(archive.entries[0].path, 'Datei 文件.txt'); assert.equal(text.decode(await archive.read('Datei 文件.txt')), 'original'); }
  finally { archive.close(); }
  for (const entries of [[{ name: '../escape', data: 'x' }], [{ name: 'a', data: 'x' }, { name: './a', data: 'y' }], [{ name: 'a', data: 'x', pax: { path: '/escape' } }]]) {
    await assert.rejects(openVaultArchive(blob(await pythonArchive('tar', entries))), { code: 'VAULT_ARCHIVE_INVALID' });
  }
});

test('TAR links, sparse metadata, missing terminators and invalid checksums are refused', async () => {
  for (const entry of [{ name: 'link', link: 'outside' }, { name: 'link', hardlink: 'outside' }, { name: 'file', data: 'x', pax: { 'GNU.sparse.name': 'hidden' } }]) {
    await assert.rejects(openVaultArchive(blob(await pythonArchive('tar', [entry]))), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  }
  const original = await pythonArchive('tar', [{ name: 'file.txt', data: 'x' }]);
  const corrupt = Buffer.from(original); corrupt[0] ^= 1;
  await assert.rejects(openVaultArchive(blob(corrupt)), { code: 'VAULT_ARCHIVE_INVALID' });
  await assert.rejects(openVaultArchive(blob(original.subarray(0, 1536))), { code: 'VAULT_ARCHIVE_INVALID' });
});

test('writer refuses traversal, normalized duplicates and limits without modifying callers', async () => {
  for (const input of [[{ name: '../escape', data: 'x' }], [{ name: 'a', data: 'x' }, { name: './a', data: 'y' }], [{ name: 'a', data: 'x' }, { name: 'a/b', data: 'y' }]]) {
    await assert.rejects(writeVaultZip(input), { code: 'VAULT_ARCHIVE_INVALID' });
  }
  await assert.rejects(writeVaultZip([{ name: 'file', data: '1234' }], { limits: { entryBytes: 3 } }), { code: 'VAULT_ARCHIVE_LIMIT' });
  await assert.rejects(writeVaultZip([{ name: 'file', data: '1234' }], { limits: { inputBytes: 20 } }), { code: 'VAULT_ARCHIVE_LIMIT' });
});

test('archive close and request cancellation deny reads and terminate an active worker', async () => {
  const archive = await openVaultArchive(blob(zipFixture([{ name: 'file', data: 'original' }])));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(archive.read('file', { signal: cancelled.signal }), { name: 'AbortError' });
  archive.close(); await assert.rejects(archive.read('file'), { name: 'AbortError' });
  let terminated = false;
  const previous = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() { terminated = true; } };
  const pendingArchive = await openVaultArchive(blob(zipFixture([{ name: 'file', data: 'original' }], { method: 8 })));
  try {
    const pending = pendingArchive.read('file');
    await new Promise(resolve => setTimeout(resolve, 0));
    pendingArchive.close();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(terminated, true);
  } finally { globalThis.Worker = previous; pendingArchive.close(); }
});

test('a stalled decompressor is terminated by its time budget', async () => {
  let terminated = false;
  const previous = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() { terminated = true; } };
  const archive = await openVaultArchive(blob(zipFixture([{ name: 'file', data: 'original' }], { method: 8 })), { limits: { milliseconds: 20 } });
  try { await assert.rejects(archive.read('file'), { code: 'VAULT_ARCHIVE_LIMIT' }); assert.equal(terminated, true); }
  finally { globalThis.Worker = previous; archive.close(); }
});

test('large archive members remain listed while extraction caps apply only to reads', async () => {
  const archive = await openVaultArchive(blob(zipFixture([{ name: 'large.bin', data: '12345678' }, { name: 'small.txt', data: 'ok' }])), { limits: { entryBytes: 4 } });
  try {
    assert.equal(archive.entries[0].readable, false); assert.equal(archive.entries[1].readable, true);
    assert.equal(archive.limits.entryBytes, 4); assert.ok(Object.isFrozen(archive.limits));
    await assert.rejects(archive.read('large.bin'), { code: 'VAULT_ARCHIVE_LIMIT' });
    assert.equal(text.decode(await archive.read('small.txt')), 'ok');
  } finally { archive.close(); }
});

test('ordinary deflated empty directory entries are verified without spawning extra decoders', async () => {
  const archive = await openVaultArchive(blob(await pythonArchive('zip', [{ name: 'directory/' }, { name: 'directory/file', data: 'text' }], { deflate: true })));
  try { assert.equal(archive.entries[0].kind, 'directory'); assert.equal(text.decode(await archive.read('directory/file')), 'text'); }
  finally { archive.close(); }
});

test('Unicode-path metadata requires its original-name CRC and cannot disagree with UTF-8 names', async () => {
  const path = encoded('Datei 文件.txt'), name = encoded('fallback.txt');
  const extra = Buffer.alloc(9 + path.length); extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5 + path.length, 2); extra[4] = 1; extra.writeUInt32LE(crc(name), 5); extra.set(path, 9);
  const archive = await openVaultArchive(blob(zipFixture([{ name, data: 'safe', extra }], { flags: 0 })));
  try { assert.equal(text.decode(await archive.read('Datei 文件.txt')), 'safe'); } finally { archive.close(); }
  const badCrc = Buffer.from(extra); badCrc[5] ^= 1;
  await assert.rejects(openVaultArchive(blob(zipFixture([{ name, data: 'x', extra: badCrc }], { flags: 0 }))), { code: 'VAULT_ARCHIVE_INVALID' });
  await assert.rejects(openVaultArchive(blob(zipFixture([{ name, data: 'x', extra }]))), { code: 'VAULT_ARCHIVE_INVALID' });
  const zip64 = new Uint8Array([1, 0, 0, 0]);
  await assert.rejects(openVaultArchive(blob(zipFixture([{ name: 'file', data: 'x', extra: zip64 }]))), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  const unixLink = new Uint8Array(17); unixLink[0] = 0x0d; unixLink[2] = 13;
  await assert.rejects(openVaultArchive(blob(zipFixture([{ name: 'file', data: 'x', extra: unixLink }]))), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
});

test('TAR.GZ and TGZ decode in a bounded worker with native gzip integrity validation', async () => {
  const tar = await pythonArchive('tar', [{ name: 'Folder/', directory: true }, { name: 'Folder/文件.txt', data: 'compressed original' }]);
  const archive = await openVaultArchive(blob(zlib.gzipSync(tar)));
  try { assert.equal(archive.format, 'tar.gz'); assert.equal(text.decode(await archive.read('Folder/文件.txt')), 'compressed original'); }
  finally { archive.close(); }
  const corrupt = zlib.gzipSync(tar); corrupt[corrupt.length - 8] ^= 1;
  await assert.rejects(openVaultArchive(blob(corrupt)), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  const forged = zlib.gzipSync(tar); forged.writeUInt32LE(1, forged.length - 4);
  await assert.rejects(openVaultArchive(blob(forged)), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
  await assert.rejects(openVaultArchive(blob(zlib.gzipSync(tar)), { limits: { expandedBytes: tar.length - 1 } }), { code: 'VAULT_ARCHIVE_LIMIT' });
});

test('concatenated gzip members fail closed with a download fallback', async () => {
  const tar = await pythonArchive('tar', [{ name: 'file', data: 'text' }]);
  await assert.rejects(openVaultArchive(blob(Buffer.concat([zlib.gzipSync(tar), zlib.gzipSync(tar)]))), { code: 'VAULT_ARCHIVE_UNSUPPORTED' });
});

test('late worker plaintext after cancellation is wiped rather than retained', async () => {
  const previous = globalThis.Worker; let worker;
  globalThis.Worker = class { constructor() { worker = this; } postMessage() {} terminate() {} };
  const archive = await openVaultArchive(blob(zipFixture([{ name: 'file', data: 'private' }], { method: 8 })));
  try {
    const pending = archive.read('file'); await new Promise(resolve => setTimeout(resolve, 0)); archive.close();
    await assert.rejects(pending, { name: 'AbortError' });
    const late = encoded('private'); worker.onmessage({ data: { bytes: late.buffer } });
    assert.deepEqual(late, new Uint8Array(late.length));
  } finally { globalThis.Worker = previous; archive.close(); }
});

test('malformed or error-bearing worker plaintext is wiped before the request is rejected', async () => {
  const previous = globalThis.Worker; let worker;
  globalThis.Worker = class { constructor() { worker = this; } postMessage() {} terminate() {} };
  try {
    for (const withError of [false, true]) {
      const archive = await openVaultArchive(blob(zipFixture([{ name: 'file', data: 'private' }], { method: 8 })));
      try {
        const pending = archive.read('file'); await new Promise(resolve => setTimeout(resolve, 0));
        const bytes = encoded('bad'); worker.onmessage({ data: { bytes: bytes.buffer, ...(withError ? { error: 'invalid' } : {}) } });
        await assert.rejects(pending, { code: 'VAULT_ARCHIVE_INVALID' }); assert.deepEqual(bytes, new Uint8Array(bytes.length));
      } finally { archive.close(); }
    }
  } finally { globalThis.Worker = previous; }
});
