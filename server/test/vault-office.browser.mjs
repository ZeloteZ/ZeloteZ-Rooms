import { exportVaultOffice, parseVaultOffice } from '/vault-office.js';
import { openVaultArchive, writeVaultZip } from '/vault-archive.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const C = 'http://schemas.openxmlformats.org/package/2006/content-types';
const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
const equal = (left, right) => assert(JSON.stringify(left) === JSON.stringify(right), JSON.stringify(left) + ' !== ' + JSON.stringify(right));
async function rejected(operation, pattern) {
  let failure;
  try { await operation(); } catch (error) { failure = error; }
  assert(failure && (!pattern || pattern.test(failure.message)), 'Expected rejection: ' + String(failure));
}
async function packageFor(format, main, extra = [], mainPart = format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml') {
  return writeVaultZip([
    { name: '_rels/.rels', data: `<Relationships xmlns="${P}"><Relationship Id="main" Type="${R}/officeDocument" Target="${mainPart}"/></Relationships>` },
    { name: '[Content_Types].xml', data: `<Types xmlns="${C}"><Override PartName="/${mainPart}" ContentType="application/vnd.openxmlformats-officedocument.${format === 'docx' ? 'wordprocessingml.document' : 'spreadsheetml.sheet'}.main+xml"/></Types>` },
    { name: mainPart, data: main }, ...extra,
  ]);
}
async function workbook(sheet, { extra = [], bookProperties = '', relations = '', sheetTarget = 'worksheets/sheet1.xml' } = {}) {
  return packageFor('xlsx', `<workbook xmlns="${S}" xmlns:r="${R}">${bookProperties}<sheets><sheet name="Data" sheetId="1" r:id="sheet"/></sheets></workbook>`, [
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="${P}"><Relationship Id="sheet" Type="${R}/worksheet" Target="${sheetTarget}"/>${relations}</Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="${S}">${sheet}</worksheet>` }, ...extra,
  ]);
}

// Invoked by the isolated Electron/Chromium QA harness with the normal web root.
export async function runVaultOfficeBrowserTests() {
  const passed = [];
  const run = async (name, operation) => { await operation(); passed.push(name); };
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error('Office parsing must never fetch a document resource'); };
  try {
    await run('DOCX text/table edit-export-reopen, escaping and original preservation', async () => {
      const original = { format: 'docx', blocks: [{ type: 'paragraph', text: 'Private 计划 <script>unsafe()</script> & \tline\nnext' },
        { type: 'table', rows: [['A', 'B'], ['C', 'D']] }] };
      const blob = await exportVaultOffice(original), source = new Uint8Array(await blob.arrayBuffer());
      const model = await parseVaultOffice(blob, 'docx');
      equal(model, original);
      model.blocks[0].text = 'Edited safely'; model.blocks[1].rows[1][0] = 'Updated cell';
      equal(await parseVaultOffice(await exportVaultOffice(model), 'docx'), model);
      equal(Array.from(new Uint8Array(await blob.arrayBuffer())), Array.from(source));
    });
    await run('XLSX edit-export-reopen preserves cell types and literal formulas', async () => {
      const model = { format: 'xlsx', sheets: [{ name: '计划 & data', rows: [['00123', '123', '12.50', 'TRUE', '2026-11-18', '=SUM(A1:A3)']],
        types: [['s', 's', 'n', 'b', 'd', 's']] }] };
      const parsed = await parseVaultOffice(await exportVaultOffice(model), 'xlsx');
      equal(parsed, model);
      parsed.sheets[0].rows[0][2] = '21.25';
      parsed.sheets[0].rows[0][3] = 'FALSE';
      equal(await parseVaultOffice(await exportVaultOffice(parsed), 'xlsx'), parsed);
    });
    await run('DOCX external hyperlinks and objects produce only passive local text', async () => {
      const text = '<img src="https://external.invalid/leak" onerror="globalThis.officeExecuted=true">';
      const main = `<m:document xmlns:m="${W}" xmlns:r="${R}"><m:body><m:p><m:hyperlink r:id="outside"><m:r><m:t>${esc(text)}</m:t></m:r></m:hyperlink>`
        + '<m:r><m:instrText>INCLUDEPICTURE "https://external.invalid"</m:instrText><m:t>field result</m:t></m:r></m:p>'
        + '<m:altChunk r:id="activeHtml"/><m:sectPr/></m:body></m:document>';
      const blob = await packageFor('docx', main, [
        { name: 'doc/_rels/main.xml.rels', data: `<Relationships xmlns="${P}"><Relationship Id="outside" Type="${R}/hyperlink" TargetMode="External" Target="https://external.invalid/leak"/></Relationships>` },
        { name: 'doc/active.html', data: '<script>globalThis.officeExecuted=true</script>' },
        { name: 'doc/vbaProject.bin', data: new Uint8Array([1, 2, 3]) },
      ], 'doc/main.xml');
      const model = await parseVaultOffice(blob, 'docx');
      equal(model.blocks, [{ type: 'paragraph', text: text + 'field result' }]);
      const stage = document.createElement('div'); stage.textContent = model.blocks[0].text;
      document.body.append(stage); assert(stage.childElementCount === 0); stage.remove();
      assert(globalThis.officeExecuted !== true);
      const copy = await openVaultArchive(await exportVaultOffice(model));
      try { assert(copy.entries.length === 3 && copy.entries.every(entry => !/html|vba|document.xml.rels/u.test(entry.path))); }
      finally { copy.close(); }
    });
    await run('XLSX shared strings, cached shared formulas and sparse cells never evaluate formulas or allocate declared dimensions', async () => {
      const blob = await workbook('<dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>'
        + '<c r="C1" t="inlineStr"><is><r><t>inline</t></r></is></c><c r="D1"><f>WEBSERVICE("https://external.invalid")</f><v>99</v></c>'
        + '<c r="E1" t="b"><v>1</v></c></row><row r="2"><c r="A2" t="str"><f t="shared" si="1"/><v>cached literal</v></c>'
        + '<c r="B2" t="b"><f t="shared" si="2"/><v>1</v></c><c r="C2"><f t="shared" si="3"/><v>12.5</v></c></row>'
        + '<row r="3"><c r="A3"><v>12.5</v></c></row></sheetData>', {
        relations: `<Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>`,
        extra: [{ name: 'xl/sharedStrings.xml', data: `<sst xmlns="${S}"><si><r><t>Shared &lt;script&gt;</t></r><rPh><t>phonetic</t></rPh><r><t> 计划</t></r></si></sst>` }],
      });
      const model = await parseVaultOffice(blob, 'xlsx');
      equal(model.sheets[0].rows, [['Shared <script> 计划', '', 'inline', '=WEBSERVICE("https://external.invalid")', 'TRUE'], ['cached literal', 'TRUE', '12.5'], ['12.5']]);
      equal(model.sheets[0].types, [['s', 's', 's', 's', 'b'], ['s', 'b', 'n'], ['n']]);
      equal(await parseVaultOffice(await exportVaultOffice(model), 'xlsx'), model);
    });
    await run('XLSX dates account for 1900 leap-day compatibility and the 1904 date system', async () => {
      for (const [properties, values, expected] of [['', [60, 61], ['1900-02-29', '1900-03-01']], ['<workbookPr date1904="1"/>', [0, 1], ['1904-01-01', '1904-01-02']]]) {
        const blob = await workbook('<sheetData><row r="1">' + values.map((value, index) => `<c r="${String.fromCharCode(65 + index)}1" s="1"><v>${value}</v></c>`).join('') + '</row></sheetData>', {
          bookProperties: properties, relations: `<Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/>`,
          extra: [{ name: 'xl/styles.xml', data: `<styleSheet xmlns="${S}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` }],
        });
        equal((await parseVaultOffice(blob, 'xlsx')).sheets[0].rows[0], expected);
      }
    });
    await run('external sheet targets, duplicate cells and enormous coordinates fail closed', async () => {
      const external = await packageFor('xlsx', `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="outside"/></sheets></workbook>`, [
        { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="${P}"><Relationship Id="outside" Type="${R}/worksheet" TargetMode="External" Target="https://external.invalid/leak"/></Relationships>` },
      ]);
      await rejected(() => parseVaultOffice(external, 'xlsx'), /invalid/u);
      for (const content of ['<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>', '<c r="XFD1"><v>1</v></c>']) {
        const blob = await workbook('<sheetData><row r="1">' + content + '</row></sheetData>');
        await rejected(() => parseVaultOffice(blob, 'xlsx'), /invalid|safety/u);
      }
    });
    await run('XML namespaces, syntax and declarations are authenticated before model extraction', async () => {
      for (const main of [
        '<!DOCTYPE document [<!ENTITY secret SYSTEM "https://external.invalid/leak">]><document/>',
        `<w:document xmlns:w="${W}"><w:body><w:p></w:body></w:document>`,
        '<document xmlns="https://untrusted.invalid/namespace"><body><p>wrong namespace</p></body></document>',
      ]) await rejected(async () => parseVaultOffice(await packageFor('docx', main), 'docx'), /invalid/u);
    });
    assert(fetches === 0, 'Office operations attempted network access');
    return { passed, fetches };
  } finally { globalThis.fetch = previousFetch; }
}
