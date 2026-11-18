import assert from 'node:assert/strict';
import test from 'node:test';
import * as pdf from '../../web/vendor/pdf-lib-1.17.1/pdf-lib.esm.js';
import { exportPdfCopy } from '../../web/vault-pdf-tools.js';

globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
const media = await import('../../web/vault-media-edit.js');

test('file classification keeps executable markup in a plain-text editor and refuses unsupported binary formats', () => {
  for (const entry of [{ name: 'page.html', type: 'text/html' }, { name: 'drawing.svg', type: 'image/svg+xml' },
    { name: 'app.js', type: 'application/javascript' }, { name: 'config.xml', type: 'application/xml' }, { name: 'data.csv' }]) assert.equal(media.vaultFileKind(entry), 'text');
  for (const [name, kind] of [['photo.png', 'image'], ['clip.mp4', 'video'], ['voice.mp3', 'audio'], ['manual.pdf', 'pdf']]) assert.equal(media.vaultFileKind({ name }), kind);
  for (const name of ['file.exe', 'file.doc', 'file.xls', 'file.heic', 'file.tiff']) assert.equal(media.vaultFileKind({ name }), 'other');
  assert.equal(media.vaultFileKind({ name: 'untrusted.html', type: 'image/png' }), 'text');
  assert.equal(media.vaultFileKind({ name: 'sound-edited.webm', type: 'audio/webm;codecs=opus' }), 'audio');
  assert.equal(media.vaultFileKind({ name: 'clip.ogg', type: 'video/ogg' }), 'video');
});

test('edited-copy names retain Unicode without crossing the byte limit or retaining unsafe path controls', () => {
  assert.equal(media.editedFileName('photo.original.jpeg', 'webp'), 'photo.original-edited.webp');
  const name = media.editedFileName('机密'.repeat(150) + '\n/\\.txt');
  assert.ok(new TextEncoder().encode(name).byteLength <= 240);
  assert.ok(!/[\p{Cc}/\\]/u.test(name));
  assert.ok(name.endsWith('-edited.txt'));
  assert.ok(!name.includes('\ufffd'));
  assert.ok(new TextEncoder().encode(media.editedFileName('x.' + 'a'.repeat(253))).byteLength <= 240);
  assert.ok(new TextEncoder().encode(media.editedFileName('x.txt', 'a'.repeat(1000))).byteLength <= 240);
});

test('crop bounds reject zero-area, non-finite and oversized local edits', () => {
  assert.deepEqual(media.imageCrop(100, 80, { left: 10, top: 25, right: 20, bottom: 25 }), { x: 10, y: 20, width: 70, height: 40 });
  for (const crop of [{ left: 100 }, { left: 70, right: 30 }, { top: NaN }, { bottom: -1 }]) assert.throws(() => media.imageCrop(100, 80, crop));
  assert.throws(() => media.imageCrop(100000, 100000));
});

test('raster previews verify passive file signatures before creating browser image resources', () => {
  assert.equal(media.rasterImageType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(media.rasterImageType(new Uint8Array([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(media.rasterImageType(new TextEncoder().encode('RIFF0000WEBPdata')), 'image/webp');
  for (const text of ['<svg onload="alert(1)">', '<!doctype html>', 'GIF-not-actually-an-image']) assert.equal(media.rasterImageType(new TextEncoder().encode(text)), null);
});

test('local asynchronous operations abort promptly even when their browser promise never settles', async () => {
  const controller = new AbortController();
  const operation = media.editorOperation(new Promise(() => {}), { signal: controller.signal, milliseconds: 10000 });
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  const already = new AbortController(); already.abort();
  await assert.rejects(media.editorOperation(Promise.resolve('late'), { signal: already.signal }), { name: 'AbortError' });
  await assert.rejects(media.editorOperation(new Promise(() => {}), { milliseconds: 5 }), /timed out/);
});

async function unsafePdf() {
  const doc = await pdf.PDFDocument.create();
  const pages = [doc.addPage([100, 200]), doc.addPage([200, 200]), doc.addPage([300, 200])];
  pages.forEach((page, index) => page.drawText('Original page ' + index, { x: 10, y: 100, size: 12 }));
  const context = doc.context;
  const name = key => pdf.PDFName.of(key);
  const script = context.register(context.obj({ S: name('JavaScript'), JS: pdf.PDFString.of('unsafeOriginalScript()') }));
  const stream = context.register(context.stream(new Uint8Array([1, 2, 3])));
  const file = context.register(context.obj({ Type: name('Filespec'), F: pdf.PDFString.of('attachment.exe'), EF: context.obj({ F: stream }) }));
  doc.catalog.set(name('OpenAction'), script);
  doc.catalog.set(name('AA'), context.obj({ O: script }));
  doc.catalog.set(name('Names'), context.obj({ JavaScript: context.obj({ Names: [pdf.PDFString.of('evil'), script] }), EmbeddedFiles: context.obj({ Names: [pdf.PDFString.of('attachment.exe'), file] }) }));
  const annotations = [
    context.register(context.obj({ Type: name('Annot'), Subtype: name('Link'), Rect: [0, 0, 10, 10], A: context.obj({ S: name('URI'), URI: pdf.PDFString.of('https://external.invalid/secret') }) })),
    context.register(context.obj({ Type: name('Annot'), Subtype: name('Widget'), Rect: [0, 0, 10, 10], A: script })),
    context.register(context.obj({ Type: name('Annot'), Subtype: name('FileAttachment'), Rect: [0, 0, 10, 10], FS: file })),
    context.register(context.obj({ Type: name('Annot'), Subtype: name('RichMedia'), Rect: [0, 0, 10, 10], RichMediaContent: file })),
    context.register(context.obj({ Type: name('Annot'), Subtype: name('Text'), Rect: [0, 0, 10, 10], Contents: pdf.PDFString.of('Passive note'), AA: context.obj({ O: script }), A: script })),
  ];
  pages[0].node.set(name('AA'), context.obj({ O: script }));
  pages[0].node.set(name('Annots'), context.obj(annotations));
  doc.catalog.set(name('AcroForm'), context.obj({ Fields: [annotations[1]] }));
  return doc.save({ useObjectStreams: false });
}

test('real PDF export reorders, rotates and removes pages while discarding active actions, links, forms and attachments', async () => {
  const source = await unsafePdf();
  const exported = await exportPdfCopy(source, [{ original: 2, rotation: 90 }, { original: 0, rotation: 180 }], { library: pdf });
  const output = await pdf.PDFDocument.load(exported);
  assert.equal(output.getPageCount(), 2);
  assert.equal(output.getPage(0).getWidth(), 300);
  assert.equal(output.getPage(1).getWidth(), 100);
  assert.equal(output.getPage(0).getRotation().angle, 90);
  assert.equal(output.getPage(1).getRotation().angle, 180);
  for (const page of output.getPages()) assert.ok(page.node.Contents(), 'original vector/text page content retained');
  for (const key of ['OpenAction', 'AA', 'Names', 'AcroForm', 'AF']) assert.equal(output.catalog.has(pdf.PDFName.of(key)), false);
  const annotation = output.getPage(1).node.lookup(pdf.PDFName.of('Annots'), pdf.PDFArray);
  assert.equal(annotation.size(), 1);
  const safe = output.context.lookup(annotation.get(0), pdf.PDFDict);
  assert.equal(safe.lookup(pdf.PDFName.of('Subtype'), pdf.PDFName).decodeText(), 'Text');
  for (const [, object] of output.context.enumerateIndirectObjects()) {
    if (!(object instanceof pdf.PDFDict)) continue;
    for (const key of ['JS', 'AA', 'OpenAction', 'FS', 'RichMediaContent', 'EmbeddedFiles']) assert.equal(object.has(pdf.PDFName.of(key)), false, key + ' absent even in orphan objects');
    const subtype = object.lookupMaybe(pdf.PDFName.of('Subtype'), pdf.PDFName)?.decodeText();
    assert.ok(!['Link', 'Widget', 'FileAttachment', 'RichMedia'].includes(subtype));
  }
  const unchanged = await pdf.PDFDocument.load(source);
  assert.ok(unchanged.catalog.has(pdf.PDFName.of('OpenAction')), 'input file stays unchanged');
  assert.equal(unchanged.getPageCount(), 3);
});

test('real PDF export embeds a passive PNG note and keeps the crop box and page rotation', async () => {
  const original = await pdf.PDFDocument.create();
  const page = original.addPage([600, 800]); page.setCropBox(20, 30, 500, 700);
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const output = await pdf.PDFDocument.load(await exportPdfCopy(await original.save(), [{ original: 0, rotation: 270 }], { library: pdf, noteImages: [png] }));
  assert.equal(output.getPage(0).getRotation().angle, 270);
  assert.deepEqual(output.getPage(0).getCropBox(), { x: 20, y: 30, width: 500, height: 700 });
  const objects = output.getPage(0).node.Resources().lookup(pdf.PDFName.of('XObject'), pdf.PDFDict);
  assert.equal(objects.keys().length, 1);
  const image = output.context.lookup(objects.values()[0]);
  assert.equal(image.dict.lookup(pdf.PDFName.of('Subtype'), pdf.PDFName).decodeText(), 'Image');
});

test('PDF export bounds and cancellation fail before a misleading edited document can be returned', async () => {
  const source = await unsafePdf();
  await assert.rejects(exportPdfCopy(source, [], { library: pdf }), /bounds/);
  await assert.rejects(exportPdfCopy(source, [{ original: 3, rotation: 0 }], { library: pdf }), /selection/);
  await assert.rejects(exportPdfCopy(source, [{ original: 0, rotation: 45 }], { library: pdf }), /selection/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportPdfCopy(source, [{ original: 0, rotation: 0 }], { library: pdf, signal: controller.signal }), { name: 'AbortError' });
});
