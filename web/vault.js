import { locale, t } from "./i18n.js";
import { api, button, closeDialog, copyField, el, field, form, notify, select, showDialog, status, tell } from "./ui.js";
import { createVaultClient, uploadNativeVaultSelection } from "./vault-client.js";
import { openVaultEditor } from "./vault-editor.js";
import { vaultFileKind } from "./vault-media-edit.js";
import { canShareVaultPlayback, openVaultRoomShare } from "./vault-room-share.js";

export function vaultBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return Math.ceil(value) + " B";
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)) - 1);
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: index ? 2 : 1 }).format(value / 1024 ** (index + 1)) + " " + units[index];
}

export function vaultSafeName(value) {
  return typeof value === "string" && value.trim() && new TextEncoder().encode(value).byteLength <= 255 && !/[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/u.test(value)
    && value !== "." && value !== ".." ? value : null;
}

export function vaultDescendants(entries, id) {
  const result = new Set([id]);
  let previous;
  do {
    previous = result.size;
    for (const entry of entries) if (result.has(entry.parentId)) result.add(entry.id);
  } while (result.size !== previous);
  return result;
}

export function vaultIntegrationState(value = {}) {
  const managers = Array.isArray(value.managers) ? value.managers : [];
  const installed = Array.isArray(value.installedManagers) ? value.installedManagers : null;
  const any = value.anyInstalled === true || value.installed === true || !!installed?.length;
  const complete = installed ? managers.length > 0 && managers.every(manager => installed.includes(manager))
    && !value.migrationManagers?.length : value.installed === true;
  return { any, complete, partial: any && !complete };
}

function validName(value) {
  const name = vaultSafeName(value.trim());
  if (!name) throw new Error(t("Use a name of up to 255 bytes without slashes or control characters.",
    "Verwende einen Namen mit höchstens 255 Bytes ohne Schrägstriche oder Steuerzeichen."));
  return name;
}

function date(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(parsed) : "—";
}

export function renderVaultLauncher({ signal, user, enabled } = {}) {
  const link = el("a", { class: "panel vault-launcher", href: "#/vault", hidden: enabled !== true,
    "aria-label": t("Open ZeloteZ Vault", "ZeloteZ Vault öffnen") },
    el("span", { class: "vault-launcher-icon vault-lock", "aria-hidden": "true" }),
    el("span", { class: "vault-launcher-copy" }, el("strong", {}, "ZeloteZ Vault"),
      el("span", {}, t("Your encrypted files", "Deine verschlüsselten Dateien"))),
    el("span", { class: "vault-launcher-arrow", "aria-hidden": "true" }, "›"));
  if (enabled === undefined && user) {
    void api("vault/config", { signal }).then(config => {
      if (!signal?.aborted) link.hidden = config.enabled !== true;
    }).catch(() => {});
  }
  return link;
}

export function renderVault(context) {
  const { signal, user } = context;
  const client = context.vault ?? createVaultClient(context);
  const feedback = status(t("Opening your vault…", "Dein Vault wird geöffnet …"));
  const rows = el("div", { class: "vault-entries", role: "list", "aria-label": t("Vault files", "Vault-Dateien"), tabindex: 0 });
  const breadcrumbList = el("ol", { class: "vault-breadcrumb-list" });
  const breadcrumbs = el("nav", { class: "vault-breadcrumbs", "aria-label": t("Folder path", "Ordnerpfad") }, breadcrumbList);
  const banner = el("div", { class: "room-header-content vault-header" },
    el("a", { class: "room-home-link", href: "#/rooms" }, t("Home", "Home")),
    el("div", { class: "room-hero vault-hero" },
      el("span", { class: "vault-banner-icon vault-lock", "aria-hidden": "true" }),
      el("div", { class: "vault-banner-copy" }, el("h1", { id: "vault-heading", tabindex: -1 }, "ZeloteZ Vault"), breadcrumbs)));
  const quotaLabel = el("p", { class: "vault-quota-label subtle" });
  const quotaBar = el("progress", { class: "vault-quota-bar", max: 1, value: 0,
    "aria-label": t("Storage used", "Belegter Speicher") });
  const quota = el("div", { class: "vault-quota", hidden: true }, quotaLabel, quotaBar);
  const transfers = el("div", { class: "vault-transfers", "aria-label": t("File transfers", "Dateiübertragungen"), hidden: true });
  const search = el("input", { type: "search", placeholder: t("Find in this folder", "In diesem Ordner suchen"),
    "aria-label": t("Find in this folder", "In diesem Ordner suchen"), autocomplete: "off", maxlength: 255 });
  const sorting = select([["name", t("Name", "Name")], ["date", t("Recently changed", "Zuletzt geändert")],
    ["size", t("Size", "Größe")]], "name");
  sorting.setAttribute("aria-label", t("Sort files", "Dateien sortieren"));
  const picker = el("input", { type: "file", multiple: true, hidden: true, "aria-label": t("Choose files", "Dateien auswählen") });
  const upload = button(t("Upload files", "Dateien hochladen"), () => picker.click(), { class: "primary", disabled: true });
  const newFolder = button(t("New folder", "Neuer Ordner"), () => editName(), { disabled: true });
  const refreshLabel = t("Refresh", "Aktualisieren");
  const refreshButton = button("↻", () => refresh(),
    { class: "ghost icon-button", disabled: true, title: refreshLabel, "aria-label": refreshLabel });
  const settingsTitle = t("Vault settings", "Vault-Einstellungen");
  const settingsButton = button("⚙", () => openSettings(),
    { class: "ghost vault-settings-button", title: settingsTitle, "aria-label": settingsTitle, "aria-haspopup": "dialog" });
  const toolbar = el("div", { class: "vault-toolbar", hidden: true },
    el("div", { class: "inline vault-toolbar-actions" }, upload, newFolder, refreshButton, picker),
    el("div", { class: "vault-toolbar-filters" }, search, sorting));
  const ownTab = button(t("My vault", "Mein Vault"), () => setView(false),
    { class: "vault-tab", id: "vault-own-tab", role: "tab", "aria-selected": "true", "aria-controls": "vault-file-panel", tabindex: 0 });
  const sharedTab = button(t("Shared with me", "Mit mir geteilt"), () => setView(true),
    { class: "vault-tab", id: "vault-shared-tab", role: "tab", "aria-selected": "false", "aria-controls": "vault-file-panel", tabindex: -1 });
  const views = el("div", { class: "vault-views", role: "tablist", "aria-label": t("Vault view", "Vault-Ansicht"), hidden: true }, ownTab, sharedTab);
  const empty = el("div", { class: "vault-empty", hidden: true });
  const dropHint = el("p", { class: "subtle vault-drop-hint", hidden: true },
    t("Drop files here to encrypt and upload them.", "Ziehe Dateien hierher, um sie verschlüsselt hochzuladen."));
  const fileArea = el("div", { class: "vault-file-area" }, feedback, empty, rows);
  const previousPage = button("‹", () => changePage(-1), { class: "ghost icon-button", "aria-label": t("Previous page", "Vorherige Seite") });
  const nextPage = button("›", () => changePage(1), { class: "ghost icon-button", "aria-label": t("Next page", "Nächste Seite") });
  const pageLabel = el("span", { class: "vault-page-label", role: "status" });
  const itemCount = el("span", { class: "vault-item-count subtle" });
  const pagination = el("div", { class: "vault-pagination", hidden: true }, el("div", { class: "vault-footer-copy" }, itemCount, dropHint),
    el("div", { class: "inline vault-page-controls" }, previousPage, pageLabel, nextPage));
  const filePanel = el("section", { class: "vault-file-panel", id: "vault-file-panel", role: "tabpanel", "aria-labelledby": ownTab.id, tabindex: 0 },
    toolbar, fileArea, pagination);
  const browser = el("section", { class: "panel vault-browser", "aria-label": t("Vault file manager", "Vault-Dateimanager") },
    el("div", { class: "vault-browser-heading" }, views, quota, settingsButton), filePanel);
  const page = el("section", { class: "secondary-page vault-page", "aria-labelledby": "vault-heading" },
    browser, transfers);
  let snapshot = { entries: [], enabled: false };
  let parentId = null;
  let generation = 0;
  let uploading = false;
  let received = false;
  let pageIndex = 0;
  let pageSize = 8;
  const jobs = new Set();
  const queue = [];
  let ownedDialog = null;
  let refreshNative = () => {};
  const desktop = globalThis.roomsVault;
  const integration = desktop ? desktopPanel() : null;

  function current() { return !signal.aborted; }
  function vaultDialog(title, content) { ownedDialog = content; showDialog(title, content); }
  function report(error) {
    if (current() && error?.name !== "AbortError") notify(error.message || t("The vault request failed.", "Die Vault-Anfrage ist fehlgeschlagen."));
  }
  function openSettings() {
    const content = el("div", { class: "stack vault-settings-dialog" },
      el("p", { class: "muted" }, t("Private files. Encrypted before upload.", "Private Dateien. Vor dem Upload verschlüsselt.")),
      el("p", { class: "subtle" },
        t("File names and contents are encrypted on your device. Keep access to your account keys; the operator cannot recover your files without them.",
          "Dateinamen und Inhalte werden auf deinem Gerät verschlüsselt. Bewahre den Zugang zu deinen Kontoschlüsseln: Der Betreiber kann deine Dateien ohne sie nicht wiederherstellen.")),
      integration);
    vaultDialog(t("Vault settings", "Vault-Einstellungen"), content);
  }
  function openEntry(entry) {
    void openVaultEditor({ entry, client, signal, onSaved: async () => { await refresh(); },
      ...(canShareVaultPlayback(entry, user) ? { onShare: () => sharePlayback(entry) } : {}) }).catch(report);
  }
  function sharePlayback(entry) {
    return openVaultRoomShare({ entry, client, user, signal }).catch(report);
  }
  function fileKind(entry) {
    const kind = vaultFileKind(entry);
    return kind === "other" ? "file" : kind;
  }
  function fileGlyph(entry) {
    return { image: "▧", video: "▷", audio: "♪", pdf: "PDF", text: "≡", office: "▤", archive: "▣", file: "▤" }[fileKind(entry)];
  }
  function entryName(entry) { return entry.name || t("Encrypted item", "Verschlüsseltes Element"); }
  function isFolder(entry) { return entry.kind === "folder"; }
  function parentOptions(excluded = new Set()) {
    return [["", t("My vault", "Mein Vault")], ...snapshot.entries.filter(entry => isFolder(entry) && !excluded.has(entry.id) && !entry.locked)
      .map(entry => [entry.id, folderPath(entry)])];
  }
  function folderPath(entry) {
    const parts = [entryName(entry)];
    const visited = new Set([entry.id]);
    let next = entry.parentId;
    while (next && !visited.has(next)) {
      visited.add(next);
      const parent = snapshot.entries.find(item => item.id === next && isFolder(item));
      if (!parent) break;
      parts.unshift(entryName(parent));
      next = parent.parentId;
    }
    return parts.join(" / ");
  }
  function openFolder(id) {
    parentId = id;
    pageIndex = 0;
    search.value = "";
    paint();
    rows.focus({ preventScroll: true });
  }
  function setView(shared) {
    received = shared; parentId = null; search.value = ""; pageIndex = 0;
    ownTab.setAttribute("aria-selected", String(!shared)); sharedTab.setAttribute("aria-selected", String(shared));
    ownTab.tabIndex = shared ? -1 : 0; sharedTab.tabIndex = shared ? 0 : -1;
    filePanel.setAttribute("aria-labelledby", shared ? sharedTab.id : ownTab.id);
    paint();
  }
  function changePage(delta) {
    pageIndex = Math.max(0, pageIndex + delta);
    paint(); rows.focus({ preventScroll: true });
  }
  function paintBreadcrumbs() {
    const chain = [];
    const visited = new Set();
    let id = parentId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = snapshot.entries.find(item => item.id === id && isFolder(item));
      if (!entry) { parentId = null; break; }
      chain.unshift(entry);
      id = entry.parentId;
    }
    const rootName = received ? t("Shared with me", "Mit mir geteilt") : t("My vault", "Mein Vault");
    const crumb = (name, action, active = false) => el("li", {}, button(name, action,
      { class: "ghost", title: name, "aria-current": active ? "page" : null }));
    const separator = () => el("li", { class: "vault-path-separator", "aria-hidden": "true" }, "›");
    const parts = [crumb(rootName, () => received ? setView(true) : openFolder(null), received || !chain.length)];
    if (!received && chain.length > 3) {
      const ancestors = chain.slice(0, -2);
      parts.push(separator(), el("li", {}, el("details", { class: "vault-path-overflow" },
        el("summary", { class: "button ghost", "aria-label": t("Parent folders", "Übergeordnete Ordner") }, "…"),
        el("div", { class: "vault-path-ancestors" }, ancestors.map(entry => button(entryName(entry), () => openFolder(entry.id), { class: "ghost" }))))));
    }
    const visible = received ? [] : chain.length > 3 ? chain.slice(-2) : chain;
    for (const entry of visible) parts.push(separator(), crumb(entryName(entry), () => openFolder(entry.id), entry.id === parentId));
    breadcrumbList.replaceChildren(...parts);
    breadcrumbs.title = [rootName, ...(received ? [] : chain.map(entryName))].join(" / ");
  }
  function paint() {
    if (!current()) return;
    const enabled = snapshot.enabled === true;
    refreshNative();
    views.hidden = !enabled;
    toolbar.hidden = !enabled;
    quota.hidden = !enabled;
    breadcrumbs.hidden = !enabled;
    dropHint.hidden = !enabled || received;
    upload.hidden = received;
    newFolder.hidden = received;
    upload.disabled = !enabled;
    newFolder.disabled = !enabled;
    refreshButton.disabled = false;
    if (!enabled) {
      rows.replaceChildren(); empty.hidden = true; pagination.hidden = true;
      tell(feedback, t("ZeloteZ Vault is not enabled on this instance.", "ZeloteZ Vault ist auf dieser Instanz nicht aktiviert."));
      return;
    }
    const used = Number(snapshot.usedBytes) || 0;
    const reserved = Number(snapshot.reservedBytes) || 0;
    const limit = Math.max(0, Number(snapshot.quotaBytes) || 0);
    quotaLabel.textContent = t("{used} of {limit} used", "{used} von {limit} belegt", { used: vaultBytes(used), limit: vaultBytes(limit) })
      + (reserved ? " · " + t("{size} uploading", "{size} im Upload", { size: vaultBytes(reserved) }) : "");
    quotaBar.max = Math.max(1, limit); quotaBar.value = Math.min(used + reserved, limit);
    paintBreadcrumbs();
    const query = search.value.trim().toLocaleLowerCase();
    const entries = (received ? snapshot.receivedEntries ?? [] : snapshot.entries).filter(entry => (received || (entry.parentId ?? null) === parentId) && entry.state !== "uploading" &&
      (!query || entryName(entry).toLocaleLowerCase().includes(query)));
    entries.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (sorting.value === "date"
      ? new Date(b.updatedAt) - new Date(a.updatedAt) : sorting.value === "size" ? (b.plainBytes ?? b.size ?? 0) - (a.plainBytes ?? a.size ?? 0)
        : entryName(a).localeCompare(entryName(b), locale(), { numeric: true })));
    pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(entries.length / pageSize) - 1));
    const first = pageIndex * pageSize;
    rows.replaceChildren(...entries.slice(first, first + pageSize).map(entryRow));
    pagination.hidden = false;
    previousPage.disabled = !pageIndex;
    nextPage.disabled = first + pageSize >= entries.length;
    pageLabel.textContent = t("{page} / {pages}", "{page} / {pages}", { page: pageIndex + 1, pages: Math.max(1, Math.ceil(entries.length / pageSize)) });
    itemCount.textContent = t("{count} items", "{count} Elemente", { count: entries.length });
    rows.hidden = !entries.length;
    empty.hidden = !!entries.length;
    empty.replaceChildren(el("span", { class: "vault-empty-icon", "aria-hidden": "true" }, "◇"),
      el("h2", {}, query ? t("No matching files", "Keine passenden Dateien") : received ? t("Nothing shared with you yet", "Noch nichts mit dir geteilt") : t("This folder is empty", "Dieser Ordner ist leer")),
      el("p", { class: "muted" }, query ? t("Try another name.", "Versuche einen anderen Namen.")
        : received ? t("Files shared directly with your account appear here.", "Dateien, die direkt mit deinem Konto geteilt werden, erscheinen hier.")
          : t("Add files or create a folder to get started.", "Füge Dateien hinzu oder erstelle einen Ordner.")));
  }
  function entryRow(entry) {
    const locked = entry.locked === true;
    const name = entryName(entry);
    const kind = fileKind(entry);
    const openLabel = kind === "audio" || kind === "video" ? t("Play", "Abspielen")
      : kind === "file" || kind === "archive" ? t("Open", "Öffnen") : t("Open and edit", "Öffnen und bearbeiten");
    const primary = button(name, () => isFolder(entry) ? openFolder(entry.id) : openEntry(entry),
      { class: "ghost vault-entry-name", disabled: locked, title: name });
    const actions = el("details", { class: "vault-entry-menu" },
      el("summary", { class: "button ghost", "aria-label": t("Actions for {name}", "Aktionen für {name}", { name }) }, "⋯"));
    const menu = el("div", { class: "vault-entry-actions" },
      !isFolder(entry) && button(openLabel, () => openEntry(entry), { disabled: locked }),
      canShareVaultPlayback(entry, user) && button(t("Play in a room", "In einem Raum abspielen"), () => void sharePlayback(entry)),
      !isFolder(entry) && button(t("Download", "Herunterladen"), () => download(entry), { disabled: locked }),
      !entry.receivedShareId && button(t("Rename", "Umbenennen"), () => editName(entry), { disabled: locked }),
      !entry.receivedShareId && button(t("Move", "Verschieben"), () => moveEntry(entry), { disabled: locked }),
      !entry.receivedShareId && !isFolder(entry) && button(t("Share", "Teilen"), () => shareEntry(entry), { disabled: locked }),
      !entry.receivedShareId && button(t("Delete", "Löschen"), () => deleteEntry(entry), { class: "danger" }));
    menu.addEventListener("click", event => { if (event.target.closest("button")) actions.open = false; });
    actions.append(menu);
    actions.addEventListener("toggle", () => {
      if (!actions.open) return;
      for (const other of rows.querySelectorAll("details[open]")) if (other !== actions) other.open = false;
      const trigger = actions.querySelector("summary").getBoundingClientRect();
      const width = Math.min(210, document.documentElement.clientWidth - 24);
      menu.style.inlineSize = width + "px";
      menu.style.insetInlineEnd = Math.max(12, document.documentElement.clientWidth - trigger.right) + "px";
      const height = menu.getBoundingClientRect().height;
      const top = trigger.bottom + height + 12 <= innerHeight ? trigger.bottom + 5 : Math.max(12, trigger.top - height - 5);
      menu.style.insetBlockStart = top + "px";
    });
    return el("div", { class: "vault-entry", role: "listitem", "data-vault-id": entry.uiId || entry.id },
      el("span", { class: "vault-entry-icon", "aria-hidden": "true", "data-kind": isFolder(entry) ? "folder" : fileKind(entry) }, locked ? "◇" : isFolder(entry) ? "▱" : fileGlyph(entry)),
      el("div", { class: "vault-entry-title" }, primary,
        el("span", { class: "subtle" }, locked ? t("This item could not be decrypted.", "Dieses Element konnte nicht entschlüsselt werden.")
          : isFolder(entry) ? t("Folder", "Ordner") : entry.type || t("File", "Datei"))),
      el("span", { class: "vault-entry-size subtle" }, isFolder(entry) ? "—" : vaultBytes(entry.plainBytes ?? entry.size)),
      el("time", { class: "vault-entry-date subtle", datetime: entry.updatedAt || entry.createdAt }, date(entry.updatedAt || entry.createdAt)), actions);
  }
  async function refresh() {
    const request = ++generation;
    refreshButton.disabled = true;
    try {
      const result = await client.list({ signal });
      if (!current() || generation !== request) return;
      snapshot = { ...result, entries: Array.isArray(result.entries) ? result.entries : [] };
      tell(feedback, ""); paint();
    } catch (error) {
      if (current()) tell(feedback, snapshot.enabled ? "" : error.message, "error");
      report(error);
    }
    finally { if (current() && generation === request) refreshButton.disabled = false; }
  }
  function nameDialog(title, initial, action) {
    const input = el("input", { type: "text", required: true, maxlength: 255, value: initial, autocomplete: "off", spellcheck: false });
    const content = form(field(t("Name", "Name"), input), t("Save", "Speichern"), async () => {
      await action(validName(input.value));
      if (!current()) return;
      closeDialog(); await refresh();
    });
    vaultDialog(title, content); input.focus(); input.select();
  }
  function editName(entry) {
    if (entry) nameDialog(t("Rename item", "Element umbenennen"), entryName(entry), name => client.rename(entry, name, { signal }));
    else {
      const destination = parentId;
      nameDialog(t("New folder", "Neuer Ordner"), "", name => client.createFolder(destination, name, { signal }));
    }
  }
  function moveEntry(entry) {
    const destination = select(parentOptions(vaultDescendants(snapshot.entries, entry.id)), entry.parentId ?? "");
    const content = form(field(t("Destination folder", "Zielordner"), destination), t("Move", "Verschieben"), async () => {
      await client.move(entry, destination.value || null, { signal });
      if (current()) { closeDialog(); await refresh(); }
    });
    vaultDialog(t("Move {name}", "{name} verschieben", { name: entryName(entry) }), content);
  }
  function deleteEntry(entry) {
    const description = isFolder(entry)
      ? t("Delete this folder, everything inside it, and their sharing links? This cannot be undone.",
        "Diesen Ordner, seinen gesamten Inhalt und zugehörige Freigabelinks löschen? Das kann nicht rückgängig gemacht werden.")
      : t("Delete this file and its sharing links? This cannot be undone.", "Diese Datei und ihre Freigabelinks löschen? Das kann nicht rückgängig gemacht werden.");
    const content = form(el("p", {}, description), t("Delete permanently", "Endgültig löschen"), async () => {
      await client.delete(entry, { signal });
      if (current()) { closeDialog(); await refresh(); }
    });
    content.querySelector('button[type="submit"]').classList.add("danger");
    vaultDialog(t("Delete {name}?", "{name} löschen?", { name: entryName(entry) }), content);
  }
  function transfer(title, task) {
    const controller = new AbortController(); jobs.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    const label = el("strong", {}, title);
    const progress = el("progress", { max: 1, value: 0, "aria-label": title });
    const note = status(t("Preparing secure transfer…", "Sichere Übertragung wird vorbereitet …"));
    const cancel = button(t("Cancel", "Abbrechen"), () => controller.abort(), { class: "ghost" });
    const node = el("section", { class: "vault-transfer", role: "status", "aria-label": title },
      el("div", { class: "section-heading" }, label, cancel), progress, note);
    transfers.hidden = false; transfers.append(node);
    const update = value => {
      if (!current()) return;
      const done = typeof value === "number" ? value : value.done ?? value.loaded ?? 0;
      const total = typeof value === "number" ? 1 : value.total ?? 1;
      progress.max = Math.max(1, total); progress.value = Math.min(done, total);
      const percent = Math.min(100, Math.round(done / Math.max(1, total) * 100));
      tell(note, typeof value === "object" && value.phase === "saving" ? t("Saving verified file…", "Geprüfte Datei wird gespeichert …")
        : typeof value === "object" && value.fileName ? t("{index}/{count} · {name} · {percent}% complete", "{index}/{count} · {name} · {percent}% abgeschlossen",
          { index: value.fileIndex, count: value.fileCount, name: value.fileName, percent })
          : t("{percent}% complete", "{percent}% abgeschlossen", { percent }));
    };
    return Promise.resolve().then(() => task({ signal: combined, onProgress: update })).then(() => {
      if (current()) notify(title + " · " + t("Completed", "Abgeschlossen"));
    }).catch(error => {
      if (current()) notify(title + " · " + (error.name === "AbortError" ? t("Cancelled", "Abgebrochen") : error.message));
    }).finally(() => {
      jobs.delete(controller);
      node.remove(); transfers.hidden = !transfers.childElementCount;
      if (current()) {
        void refresh();
      }
    });
  }
  async function processQueue() {
    if (uploading) return;
    uploading = true;
    while (queue.length && current()) {
      const { file, destination } = queue.shift();
      await transfer(t("Uploading {name}", "{name} wird hochgeladen", { name: file.name }), options => client.upload(file, destination, options));
    }
    uploading = false;
  }
  function addFiles(files) {
    if (!snapshot.enabled || !current()) return;
    for (const file of files) queue.push({ file, destination: parentId });
    void processQueue();
  }
  function download(entry) {
    // Invoke immediately while the click still carries a user activation for a
    // save-file picker. The client never opens decrypted content as active HTML.
    const controller = new AbortController();
    const options = { signal: AbortSignal.any([signal, controller.signal]) };
    const prepared = client.prepareDownload?.(entry, options);
    void transfer(t("Downloading {name}", "{name} wird heruntergeladen", { name: entryName(entry) }),
      next => client.download(entry, { ...next, prepared }));
  }
  async function shareEntry(entry) {
    const content = el("div", { class: "stack vault-share-dialog" });
    const dialogScope = new AbortController();
    const dialogSignal = AbortSignal.any([signal, dialogScope.signal]);
    document.querySelector("#dialog").addEventListener("close", () => dialogScope.abort(), { once: true });
    const note = status();
    const links = el("div", { class: "stack vault-share-list" });
    const kind = select([["link", t("Encrypted link", "Verschlüsselter Link")], ["member", t("Rooms member", "Rooms-Mitglied")]], "link");
    const recipientSearch = el("input", { type: "search", maxlength: 64, autocomplete: "off", spellcheck: false,
      placeholder: t("Search members", "Mitglieder suchen"), "aria-label": t("Search members", "Mitglieder suchen") });
    const matches = el("div", { class: "stack vault-recipient-results" });
    const memberField = el("div", { class: "stack", hidden: true }, field(t("Recipient", "Empfänger"), recipientSearch), matches);
    const duration = select([["86400", t("1 day", "1 Tag")], ["604800", t("7 days", "7 Tage")],
      ["2592000", t("30 days", "30 Tage")]], "604800");
    const result = el("div", { class: "stack vault-created-share", hidden: true });
    let recipient = null;
    let searchGeneration = 0;
    let timer;
    kind.addEventListener("change", () => { memberField.hidden = kind.value !== "member"; result.hidden = true; });
    recipientSearch.addEventListener("input", () => {
      clearTimeout(timer); recipient = null;
      const serial = ++searchGeneration;
      matches.replaceChildren();
      const query = recipientSearch.value.trim();
      if (query.length < 2) return;
      timer = setTimeout(async () => {
        try {
          const data = await client.recipients(query, { signal: dialogSignal });
          if (serial !== searchGeneration || dialogSignal.aborted || !content.isConnected) return;
          matches.replaceChildren(...data.recipients.map(person => button((person.displayName || person.username) + " · @" + person.username, () => {
            recipient = person; recipientSearch.value = "@" + person.username; matches.replaceChildren();
          }, { class: "ghost" })));
          if (!data.recipients.length) matches.append(status(t("No matching members.", "Keine passenden Mitglieder.")));
        } catch (error) { if (!dialogSignal.aborted && content.isConnected) tell(note, error.message, "error"); }
      }, 250);
    });
    dialogSignal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    function showLink(url) {
      const link = el("input", { type: "text", readonly: true, value: url, autocomplete: "off", spellcheck: false,
        "aria-label": t("Encrypted sharing link", "Verschlüsselter Freigabelink") });
      result.hidden = false;
      result.replaceChildren(field(t("Encrypted sharing link", "Verschlüsselter Freigabelink"), link),
        button(t("Copy link", "Link kopieren"), () => copyField(link)),
        el("p", { class: "subtle" }, t("Keep the complete link private. It contains the decryption key.",
          "Halte den vollständigen Link geheim. Er enthält den Entschlüsselungsschlüssel.")));
    }
    const shareForm = form([
      field(t("Sharing method", "Freigabeart"), kind),
      el("p", { class: "muted" }, t("Anyone with the complete link can decrypt this file until it expires or you revoke access. Member shares can only be opened by the selected account. Copies already downloaded cannot be revoked.",
        "Jeder mit dem vollständigen Link kann die Datei bis zum Ablauf oder Widerruf entschlüsseln. Mitgliederfreigaben kann nur das ausgewählte Konto öffnen. Bereits heruntergeladene Kopien lassen sich nicht zurückrufen.")),
      memberField, field(t("Access expires after", "Zugriff läuft ab nach"), duration),
    ], t("Share encrypted file", "Datei verschlüsselt teilen"), async () => {
      if (kind.value === "member" && !recipient) throw new Error(t("Select a member from the search results.", "Wähle ein Mitglied aus den Suchergebnissen."));
      const share = await client.createShare(entry, { recipient: kind.value === "member" ? recipient : undefined,
        expiresIn: Number(duration.value), signal: dialogSignal });
      if (!current() || !content.isConnected) return;
      if (share.url) showLink(share.url);
      else {
        result.hidden = false;
        result.replaceChildren(status(t("The file is now available in the recipient’s vault under “Shared with me”.",
          "Die Datei ist jetzt im Vault des Empfängers unter „Mit mir geteilt“ verfügbar.")));
      }
      await loadShares();
    });
    content.append(shareForm, result, el("h3", {}, t("Active shares", "Aktive Freigaben")), note, links);
    vaultDialog(t("Share {name}", "{name} teilen", { name: entryName(entry) }), content);
    async function loadShares() {
      try {
        const shares = await client.listShares(entry, { signal: dialogSignal });
        if (!current() || !content.isConnected) return;
        const active = Array.isArray(shares) ? shares : shares.shares ?? [];
        tell(note, active.length ? "" : t("No active shares.", "Keine aktiven Freigaben."));
        links.replaceChildren(...active.map(share => el("div", { class: "vault-share-row" },
          el("span", {}, (share.recipientId ? (share.recipient?.displayName || (share.recipient?.username && "@" + share.recipient.username)
            || t("Member access", "Mitgliederzugriff")) : t("Encrypted link", "Verschlüsselter Link")),
            " · ", t("Expires {date}", "Läuft ab: {date}", { date: date(share.expiresAt) })),
          el("div", { class: "inline" },
            !share.recipientId && share.ownerEnvelope && button(t("Show link", "Link anzeigen"), async event => {
              const control = event.currentTarget; control.disabled = true;
              try { showLink(await client.shareLink(share)); }
              catch (error) { if (content.isConnected) tell(note, error.message, "error"); }
              finally { control.disabled = false; }
            }, { class: "ghost" }),
            button(t("Revoke", "Widerrufen"), async event => {
              const control = event.currentTarget; control.disabled = true;
              try { await client.revokeShare(share, { signal: dialogSignal }); result.replaceChildren(); result.hidden = true; await loadShares(); }
              catch (error) { if (content.isConnected) tell(note, error.message, "error"); control.disabled = false; }
            }, { class: "danger" })))));
      } catch (error) { if (!dialogSignal.aborted && current() && content.isConnected) tell(note, error.message, "error"); }
    }
    await loadShares();
  }
  function desktopPanel() {
    const info = status();
    const pendingNote = status();
    const install = button(t("Install context menu", "Kontextmenü installieren"), () => updateIntegration(true));
    const remove = button(t("Remove context menu", "Kontextmenü entfernen"), () => updateIntegration(false), { class: "ghost" });
    const create = button(t("Encrypt and upload selected items", "Auswahl verschlüsseln und hochladen"), uploadSelection, { class: "primary", hidden: true });
    let pendingAvailable = false;
    let autoStarted = false;
    let selectionRunning = false;
    function maybeStartSelection() {
      if (!current() || !snapshot.enabled || !pendingAvailable || autoStarted || selectionRunning) return;
      autoStarted = true;
      queueMicrotask(() => { if (current() && snapshot.enabled && pendingAvailable) void uploadSelection(); });
    }
    refreshNative = () => { create.disabled = snapshot.enabled !== true || selectionRunning; maybeStartSelection(); };
    const panel = el("section", { class: "panel stack vault-desktop-panel" },
      el("h2", {}, t("File manager integration", "Dateimanager-Integration")),
      el("p", { class: "muted" }, t("Add “Share securely via Vault” to your file manager. Files keep their original names; each folder becomes a separate ZIP. Every item is encrypted on this device before upload.",
        "Ergänze „Share securely via Vault“ im Dateimanager. Dateien behalten ihren Originalnamen; jeder Ordner wird zu einem eigenen ZIP. Jedes Element wird vor dem Upload auf diesem Gerät verschlüsselt.")),
      el("p", { class: "subtle" }, t("Completely restart your file manager after installing, updating or removing its context-menu integration.",
        "Starte deinen Dateimanager nach dem Installieren, Aktualisieren oder Entfernen der Kontextmenü-Integration vollständig neu.")),
      info, el("div", { class: "inline" }, install, remove), pendingNote, create);
    async function statusIntegration() {
      try {
        const state = await desktop.integrationStatus();
        if (!current()) return;
        const integrationState = vaultIntegrationState(state);
        const missing = [...new Set((state.missingDependencies ?? []).map(item => item.component).filter(item => typeof item === "string"))];
        install.disabled = !state.supported || !!state.conflicts?.length;
        remove.hidden = !integrationState.any;
        install.hidden = integrationState.complete;
        install.textContent = integrationState.partial ? t("Update context menu", "Kontextmenü aktualisieren") : t("Install context menu", "Kontextmenü installieren");
        tell(info, state.conflicts?.length ? t("An existing context-menu entry could not be replaced safely.", "Ein vorhandener Kontextmenüeintrag konnte nicht sicher ersetzt werden.")
          : missing.length ? t("Python support is missing for a direct context-menu entry: {components}. Install the corresponding package for your distribution.",
            "Für einen direkten Kontextmenüeintrag fehlt die Python-Unterstützung: {components}. Installiere das entsprechende Paket deiner Distribution.", { components: missing.join(", ") })
            : !state.supported ? t("No supported file manager was found.", "Es wurde kein unterstützter Dateimanager gefunden.")
            : (integrationState.partial ? t("Context menu installed for some file managers", "Kontextmenü für einige Dateimanager installiert")
              : integrationState.complete ? t("Context menu installed", "Kontextmenü installiert") : t("Context menu not installed", "Kontextmenü nicht installiert"))
              + (state.managers?.length ? " · " + state.managers.join(", ") : ""));
      } catch (error) { if (current()) tell(info, error.message, "error"); }
    }
    async function updateIntegration(add) {
      install.disabled = true; remove.disabled = true;
      try { await desktop[add ? "installIntegration" : "removeIntegration"](); await statusIntegration(); }
      catch (error) { if (current()) tell(info, error.message, "error"); }
      finally { if (current()) { remove.disabled = false; await statusIntegration(); } }
    }
    async function pendingSelection() {
      try {
        const pending = await desktop.pendingArchive();
        if (!current()) return;
        pendingAvailable = pending?.available === true;
        create.hidden = !pending?.available;
        create.disabled = snapshot.enabled !== true || selectionRunning;
        tell(pendingNote, pending?.available ? t("Selected items: {count}", "Ausgewählte Elemente: {count}", { count: pending.count }) : "");
        maybeStartSelection();
      } catch (error) { if (current()) tell(pendingNote, error.message, "error"); }
    }
    async function uploadSelection() {
      if (selectionRunning || !snapshot.enabled || !current()) return;
      selectionRunning = true;
      create.disabled = true;
      const uploaded = [];
      let complete = false, failure;
      await transfer(t("Uploading selected items securely", "Auswahl wird sicher hochgeladen"), async options => {
        try {
          await uploadNativeVaultSelection(desktop, client, { ...options, parentId, onUploaded: entry => uploaded.push(entry) });
          complete = true;
        } catch (error) { failure = error; throw error; }
      });
      selectionRunning = false;
      await pendingSelection();
      if (uploaded.length && current()) {
        if (complete && uploaded.length === 1 && !document.querySelector("#dialog")?.open) await shareEntry(uploaded[0]);
        else {
          const message = complete ? t("Uploaded {count} items. Use their file menus to share them.",
            "{count} Elemente hochgeladen. Über ihre Dateimenüs kannst du sie teilen.", { count: uploaded.length })
            : t("Already uploaded: {count} items. Use their file menus to share them.",
              "Bereits hochgeladen: {count} Elemente. Über ihre Dateimenüs kannst du sie teilen.", { count: uploaded.length });
          notify(complete ? message : (failure?.name === "AbortError" ? t("Cancelled", "Abgebrochen") : failure?.message) + " · " + message);
        }
      }
    }
    const unsubscribe = desktop.onPending?.(() => { autoStarted = false; void pendingSelection(); });
    signal.addEventListener("abort", () => {
      unsubscribe?.();
      void desktop[typeof desktop.cancelSelection === "function" ? "cancelSelection" : "cancelArchive"]().catch(() => {});
    }, { once: true });
    void statusIntegration(); void pendingSelection();
    return panel;
  }
  views.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const shared = event.key === "End" ? true : event.key === "Home" ? false : !received;
    setView(shared); (shared ? sharedTab : ownTab).focus({ preventScroll: true });
  });
  search.addEventListener("input", () => { pageIndex = 0; paint(); });
  sorting.addEventListener("change", () => { pageIndex = 0; paint(); });
  picker.addEventListener("change", () => { addFiles(picker.files ?? []); picker.value = ""; });
  browser.addEventListener("dragover", event => {
    if (snapshot.enabled && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); browser.classList.add("vault-drop-active"); }
  });
  browser.addEventListener("dragleave", event => { if (!browser.contains(event.relatedTarget)) browser.classList.remove("vault-drop-active"); });
  browser.addEventListener("drop", event => {
    browser.classList.remove("vault-drop-active");
    if (!snapshot.enabled || !event.dataTransfer?.files.length) return;
    event.preventDefault(); addFiles(event.dataTransfer.files);
  });
  document.addEventListener("click", event => {
    for (const menu of rows.querySelectorAll("details[open]")) if (!menu.contains(event.target)) menu.open = false;
  }, { signal });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") for (const menu of rows.querySelectorAll("details[open]")) menu.open = false;
  }, { signal });
  const toast = document.querySelector("#toast");
  function fitRows() {
    if (!current()) return;
    if (toast) page.style.setProperty("--vault-toast-offset", toast.hidden ? "0px" : toast.getBoundingClientRect().height + 10 + "px");
    if (!fileArea.clientHeight) return;
    const rowHeight = Number.parseFloat(getComputedStyle(page).getPropertyValue("--vault-row-height")) || 60;
    const fitting = Math.max(1, Math.floor(fileArea.clientHeight / rowHeight));
    if (fitting !== pageSize) { pageSize = fitting; paint(); }
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fitRows) : null;
  observer?.observe(fileArea);
  if (toast) observer?.observe(toast);
  globalThis.addEventListener?.("resize", fitRows, { signal });
  signal.addEventListener("abort", () => {
    observer?.disconnect();
    queue.length = 0; for (const job of jobs) job.abort();
    if (ownedDialog?.isConnected) closeDialog();
    snapshot = { entries: [], enabled: false }; client.close?.();
  }, { once: true });
  paintBreadcrumbs();
  void refresh();
  return { node: page, header: banner };
}

export function renderVaultAdminPanel({ signal, approval }) {
  const enabled = el("input", { type: "checkbox" });
  const quota = el("input", { type: "number", min: "0.0009765625", max: "1024", step: "any", required: true, value: "2" });
  const loading = status(t("Loading vault settings…", "Vault-Einstellungen werden geladen …"));
  const controls = form([
    el("label", { class: "inline" }, enabled, t("Enable ZeloteZ Vault", "ZeloteZ Vault aktivieren")),
    field(t("Storage per user (GiB)", "Speicher pro Nutzer (GiB)"), quota),
    el("p", { class: "subtle" }, t("The default is 2 GiB per account. Encrypted file data counts toward this limit. Lowering the limit keeps existing files and blocks new uploads if it is exceeded.",
      "Standard sind 2 GiB pro Konto. Verschlüsselte Dateidaten zählen zum Limit. Beim Senken bleiben vorhandene Dateien erhalten; bei Überschreitung werden neue Uploads gesperrt.")),
    el("p", { class: "subtle" }, t("Disabling Vault blocks access and sharing links until you enable it again. Stored files are retained.",
      "Deaktivieren sperrt Vault-Zugriff und Freigabelinks bis zur erneuten Aktivierung. Gespeicherte Dateien bleiben erhalten.")),
  ], t("Save vault settings", "Vault-Einstellungen speichern"), async feedback => {
    const bytes = Math.round(Number(quota.value) * 1024 ** 3);
    if (!Number.isSafeInteger(bytes) || bytes < 1024 ** 2 || bytes > 1024 ** 4) throw new Error(t(
      "Choose a storage limit between 1 MiB and 1 TiB per account.", "Wähle ein Speicherlimit zwischen 1 MiB und 1 TiB pro Konto."));
    const result = await approval.mutate("vault/config", { method: "PATCH", body: { enabled: enabled.checked, quotaBytes: bytes } });
    if (signal.aborted) return;
    const config = result.config ?? result;
    enabled.checked = config.enabled; quota.value = String(config.quotaBytes / 1024 ** 3);
    tell(feedback, t("Vault settings saved.", "Vault-Einstellungen gespeichert."));
  });
  controls.hidden = true;
  const panel = el("section", { class: "panel people-panel vault-admin-panel" }, el("h2", {}, "ZeloteZ Vault"),
    el("p", { class: "muted" }, t("Optional private cloud storage and encrypted file sharing for every member.",
      "Optionaler privater Cloudspeicher und verschlüsseltes Dateiteilen für jedes Mitglied.")), loading, controls);
  void api("vault/config", { signal }).then(config => {
    if (signal.aborted) return;
    enabled.checked = config.enabled; quota.value = String(config.quotaBytes / 1024 ** 3);
    controls.hidden = false; tell(loading, "");
  }).catch(error => { if (!signal.aborted) tell(loading, error.message, "error"); });
  return panel;
}
