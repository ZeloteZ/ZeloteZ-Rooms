import assert from 'node:assert/strict';
import test from 'node:test';
import { openVaultArchive, writeVaultZip } from '../../web/vault-archive.js';
import { VAULT_OFFICE_LIMITS, exportVaultOffice, parseVaultOffice, vaultOfficeFormat } from '../../web/vault-office.js';

globalThis.location = new URL('https://rooms.example.test/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
const decode = value => new TextDecoder().decode(value);

test('Office classification supports DOCX and XLSX without pretending to support other Office containers', () => {
  assert.equal(vaultOfficeFormat({ name: 'Notes.DOCX' }), 'docx');
  assert.equal(vaultOfficeFormat({ name: 'workbook', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx');
  for (const name of ['file.doc', 'file.xls', 'file.xlsm', 'file.odt', 'file.ods', 'file.pptx', 'file.zip']) assert.equal(vaultOfficeFormat({ name }), null);
});

test('fresh DOCX export preserves supported text and tables while excluding every source relationship or active object', async () => {
  const model = { format: 'docx', blocks: [
    { type: 'paragraph', text: '<script>private()</script> & "计划"\tline one\nline two' },
    { type: 'table', rows: [['first', 'second'], ['third', 'javascript:unsafe()']] },
  ], originalZip: '<w:hyperlink r:id="external"/>', macros: 'vbaProject.bin', external: 'https://external.invalid/secret' };
  const before = structuredClone(model), blob = await exportVaultOffice(model);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual(model, before);
  const archive = await openVaultArchive(blob);
  try {
    assert.deepEqual(archive.entries.map(entry => entry.path).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const xml = decode(await archive.read('word/document.xml'));
    assert.ok(xml.includes('&lt;script&gt;private()&lt;/script&gt; &amp; &quot;计划&quot;'));
    assert.ok(xml.includes('<w:tab/>')); assert.ok(xml.includes('<w:br/>')); assert.ok(xml.includes('<w:tblGrid>'));
    assert.ok(xml.includes('javascript:unsafe()'), 'untrusted link-looking text remains passive text');
    for (const marker of ['<script>', 'hyperlink', 'vbaProject', 'https://external.invalid', 'altChunk', 'OLEObject']) assert.ok(!xml.includes(marker));
  } finally { archive.close(); }
});

test('XLSX export retains explicit numbers and booleans and never coerces text identifiers or creates formulas', async () => {
  const model = { format: 'xlsx', sheets: [{ name: '计划 & data', rows: [
    ['00123', '12345', '=WEBSERVICE("https://external.invalid")', '12.50', 'TRUE', '2026-11-18'],
    ['00123', 'Infinity', '=SUM(A1:A3)', 'FALSE', '00000000000000000001', '2026-02-30'],
  ], types: [['s', 's', 's', 'n', 'b', 'd'], ['n', 'n', 'n', 'b', 's', 'd']] }] };
  const blob = await exportVaultOffice(model), archive = await openVaultArchive(blob);
  try {
    assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(archive.entries.length, 5);
    const xml = decode(await archive.read('xl/worksheets/sheet1.xml'));
    assert.match(xml, /<c r="A1" t="inlineStr">/u);
    assert.match(xml, /<c r="B1" t="inlineStr">/u);
    assert.match(xml, /<c r="C1" t="inlineStr">/u);
    assert.match(xml, /<c r="D1"><v>12\.50<\/v><\/c>/u);
    assert.match(xml, /<c r="E1" t="b"><v>1<\/v><\/c>/u);
    assert.match(xml, /<c r="F1" t="d"><v>2026-11-18<\/v><\/c>/u);
    for (const reference of ['A2', 'B2', 'C2', 'E2', 'F2']) assert.ok(xml.includes('<c r="' + reference + '" t="inlineStr">'));
    assert.match(xml, /<c r="D2" t="b"><v>0<\/v><\/c>/u);
    assert.ok(!/<(?:\w+:)?f[ >]/u.test(xml));
    assert.ok(!xml.includes('<hyperlink'));
    const book = decode(await archive.read('xl/workbook.xml'));
    assert.ok(book.includes('name="计划 &amp; data"'));
  } finally { archive.close(); }
});

test('Office export rejects unsafe names, invalid model data and resource limits before creating a copy', async () => {
  for (const sheets of [[{ name: 'unsafe/name', rows: [] }], [{ name: 'A', rows: [] }, { name: 'a', rows: [] }], [{ name: 'A', rows: [['\0']] }],
    [{ name: 'A', rows: [Array(VAULT_OFFICE_LIMITS.columns + 1).fill('x')] }]]) await assert.rejects(exportVaultOffice({ format: 'xlsx', sheets }));
  for (const blocks of [[{ type: 'html', text: '<script>1</script>' }], [{ type: 'paragraph', text: '\ud800' }],
    [{ type: 'table', rows: [[]] }], [{ type: 'paragraph', text: 'x'.repeat(VAULT_OFFICE_LIMITS.textBytes + 1) }]]) {
    await assert.rejects(exportVaultOffice({ format: 'docx', blocks }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportVaultOffice({ format: 'docx', blocks: [] }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(parseVaultOffice(new Blob(), 'docx', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(parseVaultOffice(new Blob([new Uint8Array(VAULT_OFFICE_LIMITS.inputBytes + 1)]), 'docx'), /safety limits/u);
});

test('DTD, entity declarations and excessive XML depth or node counts are rejected before constructing a DOM', async t => {
  const original = globalThis.DOMParser;
  t.after(() => { if (original === undefined) delete globalThis.DOMParser; else globalThis.DOMParser = original; });
  let constructed = 0;
  globalThis.DOMParser = class { constructor() { constructed++; throw new Error('unsafe XML must never reach DOMParser'); } };
  for (const data of [
    '<!DOCTYPE Relationships [<!ENTITY secret SYSTEM "https://external.invalid/secret">]><Relationships/>',
    '<!ENTITY secret "expanded"><Relationships/>',
    '<r>'.repeat(VAULT_OFFICE_LIMITS.xmlDepth + 1) + '</r>'.repeat(VAULT_OFFICE_LIMITS.xmlDepth + 1),
    '<r>' + '<n/>'.repeat(VAULT_OFFICE_LIMITS.xmlNodes + 1) + '</r>',
  ]) {
    const blob = await writeVaultZip([{ name: '_rels/.rels', data }]);
    await assert.rejects(parseVaultOffice(blob, 'docx'), /invalid|safety limits/u);
  }
  assert.equal(constructed, 0);
});
