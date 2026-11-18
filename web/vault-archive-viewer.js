import { t } from "./i18n.js";
import { button, el, status, tell } from "./ui.js";
import { abortEditor } from "./vault-media-edit.js";
import { openVaultArchive, VAULT_ARCHIVE_LIMITS } from "./vault-archive.js";

function sizeLabel(size) {
  const unit = size >= 1024 ** 2 ? "MiB" : size >= 1024 ? "KiB" : "B";
  const divisor = unit === "MiB" ? 1024 ** 2 : unit === "KiB" ? 1024 : 1;
  return new Intl.NumberFormat(document.documentElement.lang || "en", { maximumFractionDigits: 1 }).format(size / divisor) + " " + unit;
}

export function vaultArchiveChildren(entries, directory = "") {
  const prefix = directory ? directory + "/" : "", children = new Map();
  for (const entry of entries) {
    const path = entry.path.replace(/\/$/u, "");
    if (!path.startsWith(prefix) || path === directory) continue;
    const relative = path.slice(prefix.length), name = relative.split("/")[0];
    if (!name) continue;
    const childPath = prefix + name, folder = relative.includes("/") || entry.kind === "directory";
    if (!children.has(childPath) || folder) children.set(childPath, folder
      ? { path: childPath, name, kind: "directory", size: 0 } : entry);
  }
  return [...children.values()].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

export async function archiveViewer(blob, entry, { signal, stage, tools, disposers, onPreview, onExtract, onDownload, onDownloadOriginal }) {
  const archive = await openVaultArchive(blob, { signal });
  abortEditor(signal);
  let directory = "", selected = null, page = 0, perPage = 6, busy = false, closed = false;
  const host = el("section", { class: "vault-archive-browser", "aria-label": t("Archive contents", "Archivinhalt") });
  const path = el("nav", { class: "vault-archive-path", "aria-label": t("Path in archive", "Pfad im Archiv") });
  const rows = el("div", { class: "vault-archive-rows", role: "list" });
  const summary = el("span", { class: "subtle", "aria-live": "polite" });
  const previous = button("‹", () => { page--; render(); }, { class: "ghost", "aria-label": t("Previous page", "Vorherige Seite") });
  const next = button("›", () => { page++; render(); }, { class: "ghost", "aria-label": t("Next page", "Nächste Seite") });
  const note = status();
  const selectedName = el("p", { class: "vault-archive-selected" });
  const preview = button(t("Open selected file", "Ausgewählte Datei öffnen"), () => act(onPreview), { class: "ghost", disabled: true });
  const extract = button(t("Save to Vault", "In Vault speichern"), () => act(onExtract), { class: "primary", disabled: true });
  const download = button(t("Download selected file", "Ausgewählte Datei herunterladen"), () => act(onDownload), { class: "ghost", disabled: true });
  const original = button(t("Download original archive", "Originalarchiv herunterladen"), () => onDownloadOriginal?.(), { class: "ghost" });
  tools.append(el("h3", {}, t("Archive tools", "Archivwerkzeuge")), selectedName, preview, extract, download, original, note);
  host.append(path, rows, el("div", { class: "vault-archive-pagination" }, previous, summary, next)); stage.append(host);
  function chooseDirectory(value) { if (busy) return; directory = value; selected = null; page = 0; tell(note, ""); render(); }
  function controls() {
    const available = selected?.kind === "file" && selected.size <= (archive.limits?.entryBytes ?? VAULT_ARCHIVE_LIMITS.entryBytes);
    for (const control of [preview, extract, download]) control.disabled = busy || !available;
    original.disabled = busy;
    selectedName.textContent = selected?.name ?? t("Select a file in the archive.", "Wähle eine Datei im Archiv.");
    if (selected && !available) tell(note, t("This member is too large for local extraction. Download the original archive instead.",
      "Diese Datei ist für das lokale Entpacken zu groß. Lade stattdessen das Originalarchiv herunter."));
  }
  function render() {
    path.replaceChildren(button(entry.name || t("Archive", "Archiv"), () => chooseDirectory(""), { class: "ghost", title: entry.name }));
    let prefix = "";
    for (const part of directory.split("/").filter(Boolean)) {
      prefix += (prefix ? "/" : "") + part;
      const target = prefix;
      path.append(el("span", { "aria-hidden": "true" }, "/"), button(part, () => chooseDirectory(target), { class: "ghost" }));
    }
    const children = vaultArchiveChildren(archive.entries, directory), pages = Math.max(1, Math.ceil(children.length / perPage));
    page = Math.max(0, Math.min(page, pages - 1));
    rows.replaceChildren(...children.slice(page * perPage, (page + 1) * perPage).map(member => {
      const folder = member.kind === "directory";
      const row = button("", () => {
        if (busy) return;
        if (folder) chooseDirectory(member.path);
        else { selected = member; tell(note, ""); render(); }
      }, { class: "ghost vault-archive-row", title: member.name,
        "aria-label": member.name, "aria-pressed": !folder && selected?.path === member.path });
      row.append(el("span", { class: "vault-entry-icon", "aria-hidden": "true" }, folder ? "▱" : "▤"),
        el("span", { class: "vault-archive-member-name" }, member.name), el("span", { class: "subtle" }, folder ? "" : sizeLabel(member.size)));
      return el("div", { role: "listitem" }, row);
    }));
    if (!children.length) rows.append(el("p", { class: "muted vault-archive-empty" }, t("This folder is empty.", "Dieser Ordner ist leer.")));
    previous.disabled = busy || page === 0; next.disabled = busy || page + 1 >= pages;
    summary.textContent = t("Page {page} of {pages} · {count} items", "Seite {page} von {pages} · {count} Elemente", { page: page + 1, pages, count: children.length });
    controls();
  }
  async function act(callback) {
    if (busy || !selected || closed || !callback) return;
    const member = selected;
    busy = true; controls();
    let bytes;
    try {
      tell(note, t("Preparing {name} locally…", "{name} wird lokal vorbereitet …", { name: member.name }));
      bytes = await archive.read(member.path, { signal, maxBytes: VAULT_ARCHIVE_LIMITS.entryBytes });
      abortEditor(signal);
      const file = new Blob([bytes]); bytes.fill(0); bytes = null;
      await callback({ entry: member, blob: file });
      abortEditor(signal);
      if (!closed && host.isConnected) tell(note, t("Completed", "Abgeschlossen"));
    } catch (error) { if (!closed && !signal.aborted && host.isConnected) tell(note, archiveError(error), "error"); }
    finally { bytes?.fill(0); busy = false; if (!closed && host.isConnected) controls(); }
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const count = Math.max(1, Math.min(24, Math.floor((host.clientHeight - 110) / 46)));
    if (count !== perPage) { perPage = count; render(); }
  }) : null;
  observer?.observe(host);
  disposers.push(() => { closed = true; observer?.disconnect(); archive.close(); selected = null; host.replaceChildren(); });
  render(); return null;
}

export function archiveError(error) {
  if (error?.code === "VAULT_ARCHIVE_LIMIT") return t("The archive exceeds the local safety limits. Download the original to open it in another app.",
    "Das Archiv überschreitet die lokalen Sicherheitsgrenzen. Lade das Original für eine andere App herunter.");
  if (error?.code === "VAULT_ARCHIVE_UNSUPPORTED") return t("This archive format or compression method is not supported locally.",
    "Dieses Archivformat oder Kompressionsverfahren wird lokal nicht unterstützt.");
  if (error?.code === "VAULT_ARCHIVE_INVALID") return t("The archive is damaged or contains unsafe entries.", "Das Archiv ist beschädigt oder enthält unsichere Einträge.");
  return error?.message || t("The archive could not be opened.", "Das Archiv konnte nicht geöffnet werden.");
}
