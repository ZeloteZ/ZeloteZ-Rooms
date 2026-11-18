import { t } from "./i18n.js";
import { openVaultArchive, writeVaultZip } from "./vault-archive.js";

export const VAULT_OFFICE_LIMITS = Object.freeze({ inputBytes: 32 * 1024 ** 2, xmlBytes: 4 * 1024 ** 2,
  expandedBytes: 16 * 1024 ** 2, textBytes: 2 * 1024 ** 2, cells: 20000, rows: 2000, columns: 64,
  sheets: 20, blocks: 2000, xmlNodes: 100000, xmlDepth: 64, cellCharacters: 32767 });
const encoder = new TextEncoder();
const W = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const S = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
const R = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
const P = new Set(["http://schemas.openxmlformats.org/package/2006/relationships"]);
const C = new Set(["http://schemas.openxmlformats.org/package/2006/content-types"]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAIN_TYPES = { docx: DOCX + ".main+xml", xlsx: XLSX + ".main+xml" };
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function invalid() { return new Error(t("This Office document is invalid or contains unsupported structures.",
  "Dieses Office-Dokument ist ungültig oder enthält nicht unterstützte Strukturen.")); }
function limit() { return new Error(t("This Office document exceeds the local editor’s safety limits.",
  "Dieses Office-Dokument überschreitet die Sicherheitsgrenzen des lokalen Editors.")); }
function abort(signal) { signal?.throwIfAborted(); }
function checkFormat(format) { if (format !== "docx" && format !== "xlsx") throw invalid(); return format; }
function known(node, namespaces, name) { return node?.nodeType === 1 && namespaces.has(node.namespaceURI) && node.localName === name; }
function children(node, namespaces, name) {
  return Array.from(node?.children ?? []).filter(child => known(child, namespaces, name));
}
function first(node, namespaces, name) { return children(node, namespaces, name)[0]; }
function attr(node, namespaces, name) {
  for (const namespace of namespaces) { const value = node.getAttributeNS(namespace, name); if (value !== null) return value; }
  return null;
}
function integer(value, maximum, minimum = 0) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw invalid();
  if (number > maximum) throw limit();
  return number;
}
function safeText(value) {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) throw invalid();
  for (const point of value) { const code = point.codePointAt(0); if (code >= 0xd800 && code <= 0xdfff) throw invalid(); }
  return value;
}
function budget() {
  let textBytes = 0, cells = 0, rows = 0, blocks = 0;
  return {
    text(value, cell = false) {
      safeText(value);
      textBytes += encoder.encode(value).byteLength;
      if (textBytes > VAULT_OFFICE_LIMITS.textBytes || (cell && value.length > VAULT_OFFICE_LIMITS.cellCharacters)) throw limit();
      return value;
    },
    cell(value) { if (++cells > VAULT_OFFICE_LIMITS.cells) throw limit(); return this.text(value, true); },
    row() { if (++rows > VAULT_OFFICE_LIMITS.rows) throw limit(); },
    block() { if (++blocks > VAULT_OFFICE_LIMITS.blocks) throw limit(); },
  };
}
export function vaultOfficeFormat(entry = {}) {
  const extension = String(entry.name ?? "").toLowerCase().split(".").pop();
  const type = String(entry.type ?? "").toLowerCase().split(";", 1)[0].trim();
  if (extension === "docx" || type === DOCX) return "docx";
  if (extension === "xlsx" || type === XLSX) return "xlsx";
  return null;
}

// Reject declarations and excessive XML structure before constructing a DOM.
// This scanner is a resource guard; the browser still validates the complete XML.
function guardXml(source) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) throw invalid();
  let position = 0, depth = 0, nodes = 0;
  for (;;) {
    const start = source.indexOf("<", position);
    if (start < 0) break;
    if (source.startsWith("<!--", start) || source.startsWith("<![CDATA[", start)) {
      const endMarker = source.startsWith("<!--", start) ? "-->" : "]]>";
      const end = source.indexOf(endMarker, start + 4);
      if (end < 0) throw invalid();
      position = end + endMarker.length;
      if (++nodes > VAULT_OFFICE_LIMITS.xmlNodes) throw limit();
      continue;
    }
    let quote = "", end = start + 1;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === source.length) throw invalid();
    if (source[start + 1] === "!") throw invalid();
    if (source[start + 1] !== "?") {
      if (++nodes > VAULT_OFFICE_LIMITS.xmlNodes) throw limit();
      if (source[start + 1] === "/") depth--;
      else if (source[end - 1] !== "/") depth++;
      if (depth < 0) throw invalid();
      if (depth > VAULT_OFFICE_LIMITS.xmlDepth) throw limit();
    }
    position = end + 1;
  }
}
function parseXml(bytes) {
  let source;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { throw invalid(); }
  guardXml(source);
  if (typeof DOMParser !== "function") throw new Error(t("Your browser cannot parse Office documents locally.",
    "Dein Browser kann Office-Dokumente nicht lokal verarbeiten."));
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.doctype || !document.documentElement || document.getElementsByTagName("parsererror").length) throw invalid();
  let nodes = 0;
  const stack = [[document.documentElement, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++nodes > VAULT_OFFICE_LIMITS.xmlNodes || depth > VAULT_OFFICE_LIMITS.xmlDepth || (node.attributes?.length ?? 0) > 128) throw limit();
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push([child, depth + 1]);
  }
  return document.documentElement;
}
function resolvePart(source, target) {
  if (typeof target !== "string" || !target || target.length > 1024 || /[\p{Cc}\\:%?#]/u.test(target)) throw invalid();
  const segments = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (!piece || piece === ".") continue;
    if (piece === "..") { if (!segments.length) throw invalid(); segments.pop(); }
    else segments.push(piece);
  }
  if (!segments.length) throw invalid();
  return segments.join("/");
}
function relationPath(part) {
  const pieces = part.split("/"), name = pieces.pop();
  return [...pieces, "_rels", name + ".rels"].join("/");
}
function relationships(root) {
  if (!known(root, P, "Relationships")) throw invalid();
  const result = new Map();
  for (const node of children(root, P, "Relationship")) {
    const id = node.getAttribute("Id"), type = node.getAttribute("Type"), target = node.getAttribute("Target");
    if (!id || !type || !target || result.has(id)) throw invalid();
    result.set(id, { type, target, external: (node.getAttribute("TargetMode") || "Internal") !== "Internal" });
  }
  return result;
}
function relationType(relation, name) { return R.some(namespace => relation?.type === namespace + "/" + name); }
function findRelation(relations, name) {
  const matches = [...relations.values()].filter(relation => relationType(relation, name));
  if (matches.length > 1) throw invalid();
  return matches[0];
}
function internalPart(source, relation) { if (!relation || relation.external) throw invalid(); return resolvePart(source, relation.target); }

function wordText(node) {
  const output = [], stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (known(current, W, "del") || known(current, W, "instrText")) continue;
    if (known(current, W, "t")) { output.push(current.textContent); continue; }
    if (known(current, W, "tab")) { output.push("\t"); continue; }
    if (known(current, W, "br") || known(current, W, "cr")) { output.push("\n"); continue; }
    for (let child = current.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
  }
  return output.join("");
}
function wordCellText(cell) {
  const paragraphs = [], stack = [cell];
  while (stack.length) {
    const node = stack.pop();
    if (known(node, W, "del")) continue;
    if (known(node, W, "p")) { paragraphs.push(wordText(node)); continue; }
    for (let child = node.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
  }
  return paragraphs.join("\n");
}
function parseDocument(root, limits) {
  if (!known(root, W, "document")) throw invalid();
  const body = first(root, W, "body");
  if (!body) throw invalid();
  const blocks = [];
  function read(container) {
    for (const node of Array.from(container.children)) {
      if (known(node, W, "p")) { limits.block(); blocks.push({ type: "paragraph", text: limits.text(wordText(node)) }); }
      else if (known(node, W, "tbl")) {
        limits.block();
        const rows = children(node, W, "tr").map(row => {
          limits.row();
          const cells = children(row, W, "tc");
          if (!cells.length) throw invalid();
          if (cells.length > VAULT_OFFICE_LIMITS.columns) throw limit();
          return cells.map(cell => limits.cell(wordCellText(cell)));
        });
        if (!rows.length) throw invalid();
        blocks.push({ type: "table", rows });
      } else if (known(node, W, "sdt")) { const content = first(node, W, "sdtContent"); if (content) read(content); }
      else if (known(node, W, "customXml") || known(node, W, "ins")) read(node);
    }
  }
  read(body);
  return { format: "docx", blocks };
}
function spreadsheetText(node) {
  if (!node) return "";
  const output = [], stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (known(current, S, "rPh")) continue;
    if (known(current, S, "t")) { output.push(current.textContent); continue; }
    for (let child = current.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
  }
  return output.join("");
}
function sheetName(value) {
  safeText(value);
  if (!value.trim() || value.length > 31 || /[:\\/?*\[\]]/u.test(value) || value.startsWith("'") || value.endsWith("'")) throw new Error(t(
    "Use unique worksheet names of up to 31 characters without : \\ / ? * [ ].",
    "Verwende eindeutige Blattnamen mit höchstens 31 Zeichen ohne : \\ / ? * [ ]."));
  return value;
}
function columnNumber(value) {
  let column = 0;
  if (!/^[A-Z]{1,3}$/u.test(value)) throw invalid();
  for (const letter of value) column = column * 26 + letter.charCodeAt(0) - 64;
  if (column > VAULT_OFFICE_LIMITS.columns) throw limit();
  return column;
}
function columnName(value) {
  let name = "";
  for (let remaining = value; remaining; remaining = Math.floor((remaining - 1) / 26)) name = String.fromCharCode(65 + (remaining - 1) % 26) + name;
  return name;
}
function dateStyle(root) {
  if (!root) return [];
  if (!known(root, S, "styleSheet")) throw invalid();
  const formats = new Map(children(first(root, S, "numFmts"), S, "numFmt").map(node => [node.getAttribute("numFmtId"), node.getAttribute("formatCode") ?? ""]));
  const styles = children(first(root, S, "cellXfs"), S, "xf");
  if (styles.length > 4096) throw limit();
  return styles.map(node => {
    const id = Number(node.getAttribute("numFmtId") ?? "0");
    if ([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58].includes(id)) return true;
    const format = (formats.get(String(id)) ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/gu, "");
    return /[yd]/iu.test(format);
  });
}
function serialDate(value, date1904) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2957000) return null;
  const days = Math.floor(serial), fraction = Math.round((serial - days) * 86400000);
  if (!date1904 && days === 60) return { text: "1900-02-29" + (fraction ? new Date(fraction).toISOString().slice(10) : ""), type: "s" };
  const time = (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) + (days - (!date1904 && days > 60 ? 1 : 0)) * 86400000 + fraction;
  const date = new Date(time);
  if (!Number.isFinite(time) || date.getUTCFullYear() > 9999) return null;
  return { text: date.toISOString().slice(0, fraction ? undefined : 10), type: "d" };
}
function validIsoDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z)?$/u.exec(value);
  if (!match || value.startsWith("0000-") || !Number.isFinite(Date.parse(value))) return false;
  const canonical = new Date(value).toISOString();
  return match[2] ? canonical === match[1] + "T" + match[2] + "." + (match[3] ?? "").padEnd(3, "0") + "Z" : canonical.slice(0, 10) === value;
}
function parseWorksheet(root, name, strings, dateStyles, date1904, limits) {
  if (!known(root, S, "worksheet")) throw invalid();
  const rows = [], types = [], seenRows = new Set(), seenCells = new Set();
  let previousRow = 0;
  for (const row of children(first(root, S, "sheetData"), S, "row")) {
    const rowIndex = row.hasAttribute("r") ? integer(row.getAttribute("r"), VAULT_OFFICE_LIMITS.rows, 1) : previousRow + 1;
    if (seenRows.has(rowIndex)) throw invalid();
    seenRows.add(rowIndex); previousRow = rowIndex;
    while (rows.length < rowIndex) { limits.row(); rows.push([]); types.push([]); }
    let previousColumn = 0;
    for (const cell of children(row, S, "c")) {
      const reference = cell.getAttribute("r");
      const match = reference ? /^([A-Z]{1,3})([1-9][0-9]*)$/u.exec(reference) : null;
      if (reference && !match) throw invalid();
      if (match && integer(match[2], VAULT_OFFICE_LIMITS.rows, 1) !== rowIndex) throw invalid();
      const column = match ? columnNumber(match[1]) : previousColumn + 1;
      if (column > VAULT_OFFICE_LIMITS.columns) throw limit();
      previousColumn = column;
      const key = rowIndex + ":" + column;
      if (seenCells.has(key)) throw invalid();
      seenCells.add(key);
      const type = cell.getAttribute("t") || "n", formula = first(cell, S, "f"), raw = first(cell, S, "v")?.textContent ?? "";
      let value, outputType = "s";
      if (formula?.textContent) value = "=" + formula.textContent;
      else if (type === "s") { const index = integer(raw, strings.length - 1); value = strings[index]; }
      else if (type === "inlineStr") value = spreadsheetText(first(cell, S, "is"));
      else if (type === "b") { if (raw !== "0" && raw !== "1") throw invalid(); value = raw === "1" ? "TRUE" : "FALSE"; outputType = "b"; }
      else if (["str", "e", "d"].includes(type)) { value = raw; outputType = type === "d" && validIsoDate(raw) ? "d" : "s"; }
      else if (type === "n") {
        value = raw; outputType = raw ? "n" : "s";
        if (raw && (!/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(raw) || !Number.isFinite(Number(raw)))) throw invalid();
        const style = cell.hasAttribute("s") ? integer(cell.getAttribute("s"), 4095) : 0;
        if (raw && dateStyles[style]) { const date = serialDate(raw, date1904); if (date) { value = date.text; outputType = date.type; } }
      } else throw invalid();
      while (rows[rowIndex - 1].length < column - 1) { limits.cell(""); rows[rowIndex - 1].push(""); types[rowIndex - 1].push("s"); }
      rows[rowIndex - 1][column - 1] = limits.cell(value);
      types[rowIndex - 1][column - 1] = outputType;
    }
  }
  return { name, rows, types };
}

export async function parseVaultOffice(blob, format, { signal } = {}) {
  checkFormat(format); abort(signal);
  if (!(blob instanceof Blob) || blob.size > VAULT_OFFICE_LIMITS.inputBytes) throw limit();
  const archive = await openVaultArchive(blob, { signal, limits: { inputBytes: VAULT_OFFICE_LIMITS.inputBytes,
    expandedBytes: VAULT_OFFICE_LIMITS.expandedBytes, entries: 1000 } });
  if (archive.format !== "zip") { archive.close(); throw invalid(); }
  const paths = new Set(archive.entries.filter(entry => entry.kind === "file").map(entry => entry.path));
  const documents = new Map();
  let xmlBytes = 0;
  async function xml(path, optional = false) {
    abort(signal);
    if (documents.has(path)) return documents.get(path);
    if (!paths.has(path)) { if (optional) return null; throw invalid(); }
    const bytes = await archive.read(path, { signal, maxBytes: VAULT_OFFICE_LIMITS.xmlBytes });
    try {
      abort(signal); xmlBytes += bytes.byteLength;
      if (xmlBytes > VAULT_OFFICE_LIMITS.expandedBytes) throw limit();
      const root = parseXml(bytes); documents.set(path, root); return root;
    } finally { bytes.fill(0); }
  }
  try {
    const main = internalPart("", findRelation(relationships(await xml("_rels/.rels")), "officeDocument"));
    const contentTypes = await xml("[Content_Types].xml");
    if (!known(contentTypes, C, "Types") || !children(contentTypes, C, "Override").some(node =>
      node.getAttribute("PartName") === "/" + main && node.getAttribute("ContentType") === MAIN_TYPES[format])) throw invalid();
    const limits = budget();
    if (format === "docx") return parseDocument(await xml(main), limits);
    const workbook = await xml(main);
    if (!known(workbook, S, "workbook")) throw invalid();
    const relations = relationships(await xml(relationPath(main)));
    const shared = findRelation(relations, "sharedStrings"), styles = findRelation(relations, "styles");
    const stringRoot = shared ? await xml(internalPart(main, shared)) : null;
    if (stringRoot && !known(stringRoot, S, "sst")) throw invalid();
    const strings = children(stringRoot, S, "si").map(spreadsheetText);
    if (strings.length > VAULT_OFFICE_LIMITS.cells) throw limit();
    const dateStyles = dateStyle(styles ? await xml(internalPart(main, styles)) : null);
    const date1904 = ["1", "true"].includes(first(workbook, S, "workbookPr")?.getAttribute("date1904"));
    const sheets = [], names = new Set();
    for (const sheet of children(first(workbook, S, "sheets"), S, "sheet")) {
      abort(signal);
      if (sheets.length >= VAULT_OFFICE_LIMITS.sheets) throw limit();
      const name = sheetName(sheet.getAttribute("name")), key = name.toLowerCase();
      if (names.has(key)) throw invalid();
      names.add(key);
      const relation = relations.get(attr(sheet, R, "id"));
      if (!relationType(relation, "worksheet")) throw invalid();
      sheets.push(parseWorksheet(await xml(internalPart(main, relation)), name, strings, dateStyles, date1904, limits));
    }
    if (!sheets.length) throw invalid();
    return { format: "xlsx", sheets };
  } finally { documents.clear(); archive.close(); }
}

function escape(value) { return safeText(value).replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }
function wordParagraph(value) {
  return "<w:p><w:r>" + value.replace(/\r\n?/gu, "\n").split(/([\t\n])/u).map(part => part === "\t" ? "<w:tab/>" : part === "\n" ? "<w:br/>"
    : '<w:t xml:space="preserve">' + escape(part) + "</w:t>").join("") + "</w:r></w:p>";
}
function validateRows(rows, limits) {
  if (!Array.isArray(rows) || rows.length > VAULT_OFFICE_LIMITS.rows) throw limit();
  return rows.map(row => {
    limits.row();
    if (!Array.isArray(row) || row.length > VAULT_OFFICE_LIMITS.columns) throw limit();
    return Array.from(row, value => limits.cell(value === undefined ? "" : value));
  });
}
function numericCell(value) {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value) || !Number.isFinite(Number(value))) return false;
  return true;
}
function spreadsheetCell(value, type, reference) {
  if (type === "b" && /^(?:TRUE|FALSE)$/u.test(value)) return '<c r="' + reference + '" t="b"><v>' + (value === "TRUE" ? "1" : "0") + "</v></c>";
  if (type === "d" && validIsoDate(value)) {
    return '<c r="' + reference + '" t="d"><v>' + escape(value) + "</v></c>";
  }
  if (type === "n" && numericCell(value)) return '<c r="' + reference + '"><v>' + value + "</v></c>";
  return '<c r="' + reference + '" t="inlineStr"><is><t xml:space="preserve">' + escape(value) + "</t></is></c>";
}
export async function exportVaultOffice(model, { signal } = {}) {
  const format = checkFormat(model?.format); abort(signal);
  const limits = budget(), files = [];
  const overrides = [];
  if (format === "docx") {
    if (!Array.isArray(model.blocks) || model.blocks.length > VAULT_OFFICE_LIMITS.blocks) throw limit();
    const content = model.blocks.map(block => {
      abort(signal); limits.block();
      if (block?.type === "paragraph") return wordParagraph(limits.text(block.text));
      if (block?.type !== "table") throw invalid();
      const rows = validateRows(block.rows, limits);
      if (!rows.length || rows.some(row => !row.length)) throw invalid();
      const grid = "<w:tblGrid>" + Array.from({ length: Math.max(...rows.map(row => row.length)) }, () => '<w:gridCol w:w="2400"/>').join("") + "</w:tblGrid>";
      return "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>" + grid + rows.map(row => "<w:tr>" + row.map(value =>
        "<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/></w:tcPr>" + wordParagraph(value) + "</w:tc>").join("") + "</w:tr>").join("") + "</w:tbl>";
    }).join("");
    files.push({ name: "word/document.xml", data: XML + '<w:document xmlns:w="' + [...W][0] + '"><w:body>' + (content || wordParagraph("")) + "<w:sectPr/></w:body></w:document>" });
    overrides.push('<Override PartName="/word/document.xml" ContentType="' + MAIN_TYPES.docx + '"/>');
  } else {
    if (!Array.isArray(model.sheets) || !model.sheets.length || model.sheets.length > VAULT_OFFICE_LIMITS.sheets) throw limit();
    const names = new Set(), workbookSheets = [], relations = [];
    for (const [index, sheet] of model.sheets.entries()) {
      abort(signal);
      const name = sheetName(sheet?.name), key = name.toLowerCase();
      if (names.has(key)) throw invalid();
      names.add(key);
      const rows = validateRows(sheet.rows, limits), part = "xl/worksheets/sheet" + (index + 1) + ".xml";
      const content = rows.map((row, rowIndex) => '<row r="' + (rowIndex + 1) + '">' + row.map((value, column) =>
        spreadsheetCell(value, sheet.types?.[rowIndex]?.[column], columnName(column + 1) + (rowIndex + 1))).join("") + "</row>").join("");
      files.push({ name: part, data: XML + '<worksheet xmlns="' + [...S][0] + '"><sheetData>' + content + "</sheetData></worksheet>" });
      workbookSheets.push('<sheet name="' + escape(name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>');
      relations.push('<Relationship Id="rId' + (index + 1) + '" Type="' + R[0] + '/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>');
      overrides.push('<Override PartName="/' + part + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    files.push({ name: "xl/workbook.xml", data: XML + '<workbook xmlns="' + [...S][0] + '" xmlns:r="' + R[0] + '"><sheets>' + workbookSheets.join("") + "</sheets></workbook>" },
      { name: "xl/_rels/workbook.xml.rels", data: XML + '<Relationships xmlns="' + [...P][0] + '">' + relations.join("") + "</Relationships>" });
    overrides.push('<Override PartName="/xl/workbook.xml" ContentType="' + MAIN_TYPES.xlsx + '"/>');
  }
  files.push({ name: "[Content_Types].xml", data: XML + '<Types xmlns="' + [...C][0] + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + overrides.join("") + "</Types>" },
    { name: "_rels/.rels", data: XML + '<Relationships xmlns="' + [...P][0] + '"><Relationship Id="rId1" Type="' + R[0] + '/officeDocument" Target="' + (format === "docx" ? "word/document.xml" : "xl/workbook.xml") + '"/></Relationships>' });
  abort(signal);
  let xmlBytes = 0;
  for (const file of files) {
    const size = encoder.encode(file.data).byteLength;
    xmlBytes += size;
    if (size > VAULT_OFFICE_LIMITS.xmlBytes || xmlBytes > VAULT_OFFICE_LIMITS.expandedBytes) throw limit();
    guardXml(file.data);
  }
  const zip = await writeVaultZip(files, { signal });
  return new Blob([zip], { type: format === "docx" ? DOCX : XLSX });
}
