import { t } from "./i18n.js";
import { button, el, field, select, status, tell } from "./ui.js";
import { abortEditor } from "./vault-media-edit.js";
import { parseVaultOffice, exportVaultOffice, vaultOfficeFormat } from "./vault-office.js";

export function officeColumnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

export async function officeEditor(blob, entry, { signal, stage, tools, dirtyChanged, disposers, readOnly = false }) {
  const model = await parseVaultOffice(blob, vaultOfficeFormat(entry), { signal });
  abortEditor(signal);
  if (readOnly === true) {
    officeViewer(model, { signal, stage, tools, disposers });
    return null;
  }
  tools.hidden = false;
  if (model.format === "docx" && !model.blocks.length) model.blocks.push({ type: "paragraph", text: "" });
  const host = el("section", { class: "vault-office", "aria-label": t("Office document", "Office-Dokument") });
  const body = el("div", { class: "vault-office-body" });
  const note = status();
  let blockIndex = 0, sheetIndex = 0, gridDisposer;
  const warning = el("p", { class: "subtle" }, t(
    "Simplified copy: text and tables are retained. Complex layout, images and embedded objects are omitted. Formulas are shown and saved as text.",
    "Vereinfachte Kopie: Text und Tabellen bleiben erhalten. Komplexes Layout, Bilder und eingebettete Objekte entfallen. Formeln werden als Text angezeigt und gespeichert."));
  const picker = select([], "0");
  picker.setAttribute("aria-label", model.format === "xlsx" ? t("Worksheet", "Tabellenblatt") : t("Document section", "Dokumentabschnitt"));
  const previous = button("‹", () => changeSection(-1), { class: "ghost", "aria-label": t("Previous section", "Vorheriger Abschnitt") });
  const next = button("›", () => changeSection(1), { class: "ghost", "aria-label": t("Next section", "Nächster Abschnitt") });
  const heading = el("div", { class: "vault-office-navigation" }, previous, picker, next);
  const type = select([["s", t("Text", "Text")], ["n", t("Number", "Zahl")], ["b", t("Boolean", "Wahrheitswert")], ["d", t("Date", "Datum")]], "s");
  const active = el("p", { class: "subtle" });
  const typeField = field(t("Cell type", "Zelltyp"), type);
  typeField.hidden = model.format !== "xlsx";
  let selectedCell = null;
  type.addEventListener("change", () => {
    if (!selectedCell || model.format !== "xlsx") return;
    const sheet = model.sheets[sheetIndex], [row, column] = selectedCell;
    sheet.types ??= []; sheet.types[row] ??= []; sheet.types[row][column] = type.value;
    dirtyChanged();
  });
  tools.append(el("h3", {}, t("Office tools", "Office-Werkzeuge")), el("details", { class: "vault-office-notice" },
    el("summary", {}, t("About the simplified copy", "Hinweise zur vereinfachten Kopie")), warning), typeField, active, note);
  host.append(heading, body); stage.append(host);
  function sections() { return model.format === "xlsx" ? model.sheets : model.blocks; }
  function currentIndex() { return model.format === "xlsx" ? sheetIndex : blockIndex; }
  function changeSection(delta) {
    const index = Math.max(0, Math.min(sections().length - 1, currentIndex() + delta));
    if (model.format === "xlsx") sheetIndex = index; else blockIndex = index;
    render();
  }
  picker.addEventListener("change", () => {
    if (model.format === "xlsx") sheetIndex = Number(picker.value); else blockIndex = Number(picker.value);
    render();
  });
  function rebuildPicker() {
    const values = sections();
    picker.replaceChildren(...values.map((section, index) => el("option", { value: String(index) }, model.format === "xlsx" ? section.name
      : t("{index} · {kind}", "{index} · {kind}", { index: index + 1, kind: section.type === "table" ? t("Table", "Tabelle") : t("Paragraph", "Absatz") }))));
    picker.value = String(currentIndex()); previous.disabled = currentIndex() === 0; next.disabled = currentIndex() >= values.length - 1;
  }
  function render() {
    gridDisposer?.(); gridDisposer = null; selectedCell = null; active.textContent = "";
    body.replaceChildren(); rebuildPicker();
    const section = sections()[currentIndex()];
    if (model.format === "docx" && section.type === "paragraph") {
      const input = el("textarea", { class: "vault-text-editor vault-office-paragraph", spellcheck: true,
        autocomplete: "off", "aria-label": t("Paragraph text", "Absatztext"), maxlength: 2 * 1024 ** 2 });
      input.value = section.text;
      input.addEventListener("input", () => { section.text = input.value; dirtyChanged(); });
      body.append(input);
    } else gridDisposer = officeGrid(section, body, {
      dirtyChanged, typed: model.format === "xlsx", signal,
      focus(row, column) {
        selectedCell = [row, column]; type.value = section.types?.[row]?.[column] ?? "s";
        active.textContent = t("Selected cell: {cell}", "Ausgewählte Zelle: {cell}", { cell: officeColumnName(column) + (row + 1) });
      }, error: message => tell(note, message, "error"),
    });
  }
  if (model.format === "docx") {
    const add = type => {
      if (model.blocks.length >= 2000) { tell(note, t("The document section limit has been reached.", "Die maximale Zahl an Dokumentabschnitten ist erreicht."), "error"); return; }
      model.blocks.splice(blockIndex + 1, 0, type === "table" ? { type, rows: [["", ""], ["", ""]] } : { type, text: "" });
      blockIndex++; dirtyChanged(); render();
    };
    tools.append(button(t("Add paragraph", "Absatz hinzufügen"), () => add("paragraph"), { class: "ghost" }),
      button(t("Add table", "Tabelle hinzufügen"), () => add("table"), { class: "ghost" }),
      button(t("Remove section", "Abschnitt entfernen"), () => {
        if (model.blocks.length === 1) return;
        model.blocks.splice(blockIndex, 1); blockIndex = Math.min(blockIndex, model.blocks.length - 1); dirtyChanged(); render();
      }, { class: "ghost" }));
  }
  disposers.push(() => {
    gridDisposer?.();
    for (const input of host.querySelectorAll("input,textarea")) input.value = "";
    if (model.blocks) model.blocks.length = 0;
    if (model.sheets) model.sheets.length = 0;
  });
  render();
  return options => exportVaultOffice(model, options);
}

function officeViewer(model, { signal, stage, tools, disposers }) {
  const host = el("section", { class: "vault-office vault-office-readonly", "aria-label": t("Office document", "Office-Dokument") });
  const body = el("div", { class: "vault-office-body vault-office-readonly-body" });
  let alive = true, sheetIndex = 0;
  function table(rows, worksheet = false) {
    const grid = el("table", { class: "vault-office-table vault-office-readonly-table" });
    const columns = Math.max(1, ...rows.map(row => row.length));
    if (worksheet) grid.append(el("thead", {}, el("tr", {}, el("th", { scope: "col" }, ""),
      Array.from({ length: columns }, (_, index) => el("th", { scope: "col" }, officeColumnName(index))))));
    grid.append(el("tbody", {}, rows.map((row, index) => el("tr", {},
      worksheet && el("th", { scope: "row" }, String(index + 1)),
      row.map(value => el("td", {}, value)),
      row.length < columns && el("td", { colspan: columns - row.length }, "")))));
    return grid;
  }
  if (model.format === "docx") {
    body.append(...model.blocks.map(block => block.type === "paragraph"
      ? el("p", { class: "vault-office-readonly-paragraph" }, block.text) : table(block.rows)));
    if (!model.blocks.length) body.append(el("p", { class: "subtle" }, t("This document is empty.", "Dieses Dokument ist leer.")));
  } else {
    const picker = select(model.sheets.map((sheet, index) => [String(index), sheet.name]), "0");
    picker.setAttribute("aria-label", t("Worksheet", "Tabellenblatt"));
    const previous = button("‹", () => changeSheet(sheetIndex - 1), { class: "ghost", "aria-label": t("Previous section", "Vorheriger Abschnitt") });
    const next = button("›", () => changeSheet(sheetIndex + 1), { class: "ghost", "aria-label": t("Next section", "Nächster Abschnitt") });
    function changeSheet(index) {
      if (!alive || signal?.aborted || !Number.isInteger(index) || index < 0 || index >= model.sheets.length) return;
      sheetIndex = index; renderSheet();
    }
    function renderSheet() {
      const sheet = model.sheets[sheetIndex];
      body.replaceChildren(sheet?.rows.length ? table(sheet.rows, true)
        : el("p", { class: "subtle" }, t("This worksheet is empty.", "Dieses Tabellenblatt ist leer.")));
      picker.value = String(sheetIndex);
      previous.disabled = sheetIndex === 0; next.disabled = sheetIndex >= model.sheets.length - 1;
    }
    picker.addEventListener("change", () => changeSheet(Number(picker.value)));
    host.append(el("div", { class: "vault-office-navigation" }, previous, picker, next));
    renderSheet();
  }
  function cleanup() {
    if (!alive) return;
    alive = false; signal?.removeEventListener("abort", cleanup);
    for (const item of host.querySelectorAll("p,td,th,option")) item.textContent = "";
    host.replaceChildren();
    for (const section of model.blocks ?? model.sheets ?? []) {
      if (section.type === "paragraph") section.text = "";
      if (typeof section.name === "string") section.name = "";
      for (const row of section.rows ?? []) row.fill("");
      if (section.rows) section.rows.length = 0;
    }
    if (model.blocks) model.blocks.length = 0;
    if (model.sheets) model.sheets.length = 0;
  }
  tools.hidden = true; host.append(body); stage.append(host);
  disposers.push(cleanup);
  signal?.addEventListener("abort", cleanup, { once: true });
}

function officeGrid(sheet, host, { dirtyChanged, typed, focus, error, signal }) {
  sheet.rows ??= [[]]; if (!sheet.rows.length) sheet.rows.push([]);
  if (typed) sheet.types ??= [];
  const shell = el("div", { class: "vault-office-grid" });
  const table = el("table", { class: "vault-office-table" });
  const page = el("span", { class: "subtle", "aria-live": "polite" });
  let rowPage = 0, columnPage = 0, visibleRows = 4, visibleColumns = 4;
  const backRows = button("↑", () => { rowPage--; render(); }, { class: "ghost", "aria-label": t("Previous rows", "Vorherige Zeilen") });
  const nextRows = button("↓", () => { rowPage++; render(); }, { class: "ghost", "aria-label": t("Next rows", "Nächste Zeilen") });
  const backColumns = button("←", () => { columnPage--; render(); }, { class: "ghost", "aria-label": t("Previous columns", "Vorherige Spalten") });
  const nextColumns = button("→", () => { columnPage++; render(); }, { class: "ghost", "aria-label": t("Next columns", "Nächste Spalten") });
  const addRow = button(t("+ Row", "+ Zeile"), () => {
    const columns = columnCount();
    if (sheet.rows.length >= 2000 || (sheet.rows.length + 1) * columns > 20000) { limit(); return; }
    sheet.rows.push(Array(columns).fill("")); if (typed) sheet.types.push(Array(columns).fill("s"));
    rowPage = Math.floor((sheet.rows.length - 1) / visibleRows); dirtyChanged(); render();
  }, { class: "ghost" });
  const addColumn = button(t("+ Column", "+ Spalte"), () => {
    const columns = columnCount();
    if (columns >= 64 || sheet.rows.length * (columns + 1) > 20000) { limit(); return; }
    sheet.rows.forEach((row, index) => {
      while (row.length <= columns) row.push("");
      if (typed) { sheet.types[index] ??= []; while (sheet.types[index].length <= columns) sheet.types[index].push("s"); }
    });
    columnPage = Math.floor(columns / visibleColumns); dirtyChanged(); render();
  }, { class: "ghost" });
  function limit() { error(t("The table size limit has been reached.", "Die maximale Tabellengröße ist erreicht.")); }
  function columnCount() { return Math.max(1, ...sheet.rows.map(row => row.length)); }
  const controls = el("div", { class: "vault-office-grid-controls" }, backRows, nextRows, backColumns, nextColumns, page, addRow, addColumn);
  shell.append(table, controls); host.append(shell);
  function render() {
    const columns = columnCount();
    rowPage = Math.max(0, Math.min(rowPage, Math.ceil(sheet.rows.length / visibleRows) - 1));
    columnPage = Math.max(0, Math.min(columnPage, Math.ceil(columns / visibleColumns) - 1));
    const firstRow = rowPage * visibleRows, firstColumn = columnPage * visibleColumns;
    const head = el("tr", {}, el("th", { scope: "col" }, ""));
    for (let column = firstColumn; column < Math.min(columns, firstColumn + visibleColumns); column++) head.append(el("th", { scope: "col" }, officeColumnName(column)));
    const body = el("tbody");
    for (let row = firstRow; row < Math.min(sheet.rows.length, firstRow + visibleRows); row++) {
      const line = el("tr", {}, el("th", { scope: "row" }, String(row + 1)));
      for (let column = firstColumn; column < Math.min(columns, firstColumn + visibleColumns); column++) {
        const input = el("input", { type: "text", autocomplete: "off", spellcheck: false,
          "aria-label": officeColumnName(column) + (row + 1), maxlength: 32767 });
        input.value = sheet.rows[row][column] ?? "";
        input.addEventListener("focus", () => focus(row, column));
        input.addEventListener("input", () => { sheet.rows[row][column] = input.value; dirtyChanged(); });
        line.append(el("td", {}, input));
      }
      body.append(line);
    }
    table.replaceChildren(el("thead", {}, head), body);
    backRows.disabled = firstRow === 0; nextRows.disabled = firstRow + visibleRows >= sheet.rows.length;
    backColumns.disabled = firstColumn === 0; nextColumns.disabled = firstColumn + visibleColumns >= columns;
    page.textContent = t("Rows {from}–{to} of {total}", "Zeilen {from}–{to} von {total}",
      { from: firstRow + 1, to: Math.min(sheet.rows.length, firstRow + visibleRows), total: sheet.rows.length });
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const rows = Math.max(1, Math.min(12, Math.floor((shell.clientHeight - 150) / 38)));
    const columns = Math.max(1, Math.min(8, Math.floor((shell.clientWidth - 42) / 110)));
    if (rows !== visibleRows || columns !== visibleColumns) { visibleRows = rows; visibleColumns = columns; render(); }
  }) : null;
  observer?.observe(shell); render();
  return () => { observer?.disconnect(); for (const input of shell.querySelectorAll("input")) input.value = ""; };
}
