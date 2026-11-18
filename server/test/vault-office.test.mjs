import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

// Exercise the actual Office renderer separately from XML parsing (covered
// above and by the real-browser Office fixtures). No browser/network is needed.
class OfficeElement extends EventTarget {
  constructor(tag, attrs = {}) {
    super(); this.tag = tag; this.attrs = attrs; this.children = []; this.value = attrs.value ?? '';
    this.hidden = attrs.hidden ?? false; this.disabled = attrs.disabled ?? false;
  }
  append(...values) { this.children.push(...values.flat(Infinity).filter(value => value !== false && value != null)); }
  replaceChildren(...values) { this.children = []; this.append(...values); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get textContent() { return this.children.map(value => value instanceof OfficeElement ? value.textContent : String(value)).join(''); }
  set innerHTML(_value) { throw new Error('Office content must never be inserted as HTML'); }
  setAttribute(name, value) { this.attrs[name] = value; }
  querySelectorAll(selector) {
    const tags = selector.split(','), found = [];
    for (const child of this.children) if (child instanceof OfficeElement) {
      if (tags.includes(child.tag)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}
const officeUi = {
  t: value => value,
  el(tag, attrs, ...children) { const node = new OfficeElement(tag, attrs); node.append(...children); return node; },
  button(text, action, attrs) { const node = officeUi.el('button', attrs, text); node.addEventListener('click', action); return node; },
  select(options, value) { const node = officeUi.el('select', {}, options.map(([value, name]) => officeUi.el('option', { value }, name))); node.value = value; return node; },
  field: (name, node) => officeUi.el('label', {}, name, node),
  status: () => officeUi.el('p', {}),
  tell(node, text) { node.textContent = text; },
};
const officeEditorUrl = new URL('../../web/vault-office-editor.js', import.meta.url);
const rendererSource = (await readFile(officeEditorUrl, 'utf8'))
  .replace('import { t } from "./i18n.js";', 'const { t } = globalThis.__officeRendererUI;')
  .replace('import { button, el, field, select, status, tell } from "./ui.js";', 'const { button, el, field, select, status, tell } = globalThis.__officeRendererUI;')
  .replace('import { parseVaultOffice, exportVaultOffice, vaultOfficeFormat } from "./vault-office.js";',
    'const parseVaultOffice = (...args) => globalThis.__officeRendererParse(...args); const exportVaultOffice = (...args) => globalThis.__officeRendererExport(...args); const vaultOfficeFormat = entry => entry.name.endsWith(".docx") ? "docx" : "xlsx";')
  .replace(/from "\.\/([^"]+)"/gu, (_, path) => 'from ' + JSON.stringify(new URL(path, officeEditorUrl).href));
globalThis.__officeRendererUI = officeUi;
const { officeEditor } = await import('data:text/javascript;base64,' + Buffer.from(rendererSource).toString('base64'));
delete globalThis.__officeRendererUI;
function rendererFixture(t, model) {
  const state = { dirty: 0, parses: [], exports: [], disposers: [], stage: officeUi.el('div', {}), tools: officeUi.el('aside', {}) };
  globalThis.__officeRendererParse = async (...args) => { state.parses.push(args); return model; };
  globalThis.__officeRendererExport = async (...args) => { state.exports.push(args); return new Blob(['fresh exported copy']); };
  state.controller = new AbortController();
  state.environment = { signal: state.controller.signal, stage: state.stage, tools: state.tools,
    dirtyChanged() { state.dirty++; }, disposers: state.disposers };
  t.after(() => { state.disposers.forEach(dispose => dispose()); delete globalThis.__officeRendererParse; delete globalThis.__officeRendererExport; });
  return state;
}

test('read-only DOCX renders every paragraph and table as passive text without a save builder', async t => {
  const content = '<img src="https://external.invalid/leak" onerror="private()"> & 计划';
  const model = { format: 'docx', blocks: [{ type: 'paragraph', text: content },
    { type: 'table', rows: [['first', '=HYPERLINK("https://external.invalid")'], ['last']] }, { type: 'paragraph', text: 'End\nNext line' }] };
  const before = structuredClone(model), f = rendererFixture(t, model);
  const builder = await officeEditor(new Blob(['bounded Office input']), { name: 'file.docx' }, { ...f.environment, readOnly: true });
  assert.equal(builder, null); assert.equal(f.tools.hidden, true);
  assert.ok(f.stage.textContent.includes(content)); assert.ok(f.stage.textContent.includes('End\nNext line'));
  assert.equal(f.stage.querySelectorAll('table').length, 1);
  assert.equal(f.stage.querySelectorAll('textarea,input,button,select,script,img,a').length, 0);
  assert.deepEqual(model, before); assert.equal(f.dirty, 0); assert.equal(f.exports.length, 0);
  assert.equal(f.parses[0][1], 'docx'); assert.equal(f.parses[0][2].signal, f.controller.signal);
  f.disposers.forEach(dispose => dispose());
  assert.equal(f.stage.textContent, ''); assert.equal(model.blocks.length, 0);
});

test('read-only XLSX sheet navigation is passive and abort removes text without mutating the workbook', async t => {
  const model = { format: 'xlsx', sheets: [{ name: '<script>first</script>', rows: [['00123', '=SUM(A1:A3)'], []] },
    { name: '计划 Second', rows: [['Second sheet', 'https://external.invalid']] }] };
  const before = structuredClone(model), f = rendererFixture(t, model);
  assert.equal(await officeEditor(new Blob(), { name: 'data.xlsx' }, { ...f.environment, readOnly: true }), null);
  const picker = f.stage.querySelectorAll('select')[0], controls = f.stage.querySelectorAll('button');
  assert.equal(controls.length, 2); assert.ok(f.stage.textContent.includes('00123'));
  assert.equal(f.stage.querySelectorAll('input,textarea,script,a').length, 0);
  picker.value = '1'; picker.dispatchEvent(new Event('change'));
  assert.ok(f.stage.textContent.includes('Second sheet')); assert.ok(!f.stage.textContent.includes('00123'));
  controls[0].dispatchEvent(new Event('click'));
  assert.ok(f.stage.textContent.includes('00123'));
  picker.value = '999'; picker.dispatchEvent(new Event('change'));
  assert.ok(f.stage.textContent.includes('00123'));
  assert.deepEqual(model, before); assert.equal(f.dirty, 0); assert.equal(f.exports.length, 0);
  f.controller.abort(); assert.equal(f.stage.textContent, '');
  picker.value = '1'; picker.dispatchEvent(new Event('change'));
  assert.equal(f.stage.textContent, ''); assert.equal(model.sheets.length, 0);
});

test('empty read-only documents do not acquire synthetic editable paragraphs or rows', async t => {
  const model = { format: 'docx', blocks: [] }, f = rendererFixture(t, model);
  assert.equal(await officeEditor(new Blob(), { name: 'empty.docx' }, { ...f.environment, readOnly: true }), null);
  assert.ok(f.stage.textContent.includes('This document is empty.'));
  assert.deepEqual(model.blocks, []); assert.equal(f.stage.querySelectorAll('input,textarea,button').length, 0);
});

test('Office mode remains editable by default and returns the existing export builder', async t => {
  const model = { format: 'docx', blocks: [{ type: 'paragraph', text: 'Original' }] }, f = rendererFixture(t, model);
  f.tools.hidden = true;
  const builder = await officeEditor(new Blob(), { name: 'file.docx' }, f.environment);
  assert.equal(typeof builder, 'function'); assert.equal(f.tools.hidden, false);
  const input = f.stage.querySelectorAll('textarea')[0];
  input.value = 'Edited'; input.dispatchEvent(new Event('input'));
  assert.equal(f.dirty, 1); assert.equal(model.blocks[0].text, 'Edited');
  const options = { signal: f.controller.signal };
  assert.ok(await builder(options) instanceof Blob);
  assert.equal(f.exports[0][0], model); assert.equal(f.exports[0][1], options);
});

test('passive ragged worksheets keep DOM cells bounded by actual cells plus one gap per row', async t => {
  const rows = [Array(64).fill('header'), ...Array.from({ length: 1999 }, () => ['value'])];
  const f = rendererFixture(t, { format: 'xlsx', sheets: [{ name: 'Bounded', rows }] });
  await officeEditor(new Blob(), { name: 'data.xlsx' }, { ...f.environment, readOnly: true });
  assert.equal(f.stage.querySelectorAll('td').length, 64 + 1999 * 2);
  assert.equal(f.stage.querySelectorAll('input,textarea').length, 0);
  assert.equal(f.dirty, 0);
});

test('abort while Office parsing is pending cannot mount a late read-only document', async t => {
  const f = rendererFixture(t, { format: 'docx', blocks: [] });
  let resolve;
  globalThis.__officeRendererParse = () => new Promise(done => { resolve = done; });
  const pending = officeEditor(new Blob(), { name: 'file.docx' }, { ...f.environment, readOnly: true });
  f.controller.abort(); resolve({ format: 'docx', blocks: [{ type: 'paragraph', text: 'must not appear' }] });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.stage.children.length, 0); assert.equal(f.disposers.length, 0);
});
