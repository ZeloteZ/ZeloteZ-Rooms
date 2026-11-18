import { locale, t } from "./i18n.js";
import { api, button, closeDialog, copyField, el, field, form, notify, select, showDialog, status, tell } from "./ui.js";
import { createVaultClient, uploadNativeVaultSelection } from "./vault-client.js";
import { mountVaultEditor } from "./vault-editor.js";
import { createVaultExplorerModel, vaultExplorerView, navigateVaultExplorer, validateVaultExplorerMove } from "./vault-explorer-model.js";
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
  const breadcrumbList = el("ol", { class: "vault-breadcrumb-list" });
  const breadcrumbs = el("nav", { class: "vault-breadcrumbs", "aria-label": t("Folder path", "Ordnerpfad") }, breadcrumbList);
  const quotaLabel = el("p", { class: "vault-quota-label subtle" });
  const quotaBar = el("progress", { class: "vault-quota-bar", max: 1, value: 0, "aria-label": t("Storage used", "Belegter Speicher") });
  const quota = el("div", { class: "vault-quota", hidden: true }, quotaLabel, quotaBar);
  const settingsTitle = t("Vault settings", "Vault-Einstellungen");
  const settingsButton = button("⚙", () => openSettings(), { class: "ghost vault-settings-button", title: settingsTitle, "aria-label": settingsTitle, "aria-haspopup": "dialog" });
  const banner = el("div", { class: "room-header-content vault-header" },
    el("a", { class: "room-home-link", href: "#/rooms" }, t("Home", "Home")),
    el("div", { class: "room-hero vault-hero" },
      el("h1", { id: "vault-heading", class: "sr-only", tabindex: -1 }, t("Files", "Dateien")), breadcrumbs,
      el("div", { class: "vault-header-actions" }, quota, settingsButton)));
  const transfers = el("div", { class: "vault-transfers", "aria-label": t("File transfers", "Dateiübertragungen"), hidden: true });
  const search = el("input", { type: "search", placeholder: t("Find in this folder", "In diesem Ordner suchen"),
    "aria-label": t("Find in this folder", "In diesem Ordner suchen"), autocomplete: "off", maxlength: 255 });
  const sorting = select([["name", t("Name", "Name")], ["date", t("Recently changed", "Zuletzt geändert")], ["size", t("Size", "Größe")]], "name");
  sorting.setAttribute("aria-label", t("Sort files", "Dateien sortieren"));
  const picker = el("input", { type: "file", multiple: true, hidden: true, "aria-label": t("Choose files", "Dateien auswählen") });
  let pickerDestination = null;
  const upload = button(t("Upload files", "Dateien hochladen"), () => pickFiles(activeFolderRef()), { class: "primary", disabled: true });
  const newFolder = button(t("New folder", "Neuer Ordner"), () => editName(), { disabled: true });
  const refreshLabel = t("Refresh", "Aktualisieren");
  const refreshButton = button("↻", () => refresh(), { class: "ghost icon-button", disabled: true, title: refreshLabel, "aria-label": refreshLabel });
  const folderStatus = el("span", { class: "vault-folder-status subtle", role: "status" });
  const toolbar = el("div", { class: "vault-toolbar", hidden: true },
    el("div", { class: "inline vault-toolbar-actions" }, upload, newFolder, refreshButton, picker),
    el("div", { class: "vault-toolbar-filters" }, search, sorting), folderStatus);
  const columns = el("div", { class: "vault-columns", "aria-label": t("Folders", "Ordner") });
  const previewEmpty = el("div", { class: "vault-preview-empty" },
    el("span", { class: "vault-preview-symbol", "aria-hidden": "true" }, "▤"),
    el("h2", {}, t("Choose a file", "Wähle eine Datei")),
    el("p", { class: "muted" }, t("Open a file beside your folders. Your files stay encrypted in Vault.",
      "Öffne eine Datei neben deinen Ordnern. Deine Dateien bleiben im Vault verschlüsselt.")));
  const previewTitle = el("h2", { class: "vault-preview-name", tabindex: -1 });
  const previewPath = el("p", { class: "vault-preview-path subtle" });
  const previewShared = el("span", { class: "vault-shared-badge", hidden: true }, t("Shared", "Geteilt"));
  const previewClose = button("×", () => closePreview(), { class: "ghost icon-button", "aria-label": t("Close file", "Datei schließen"), title: t("Close file", "Datei schließen") });
  const previewHeader = el("header", { class: "vault-preview-heading", hidden: true },
    el("div", { class: "vault-preview-heading-copy" }, previewTitle, previewPath), previewShared, previewClose);
  const previewBody = el("div", { class: "vault-preview-body" }, previewEmpty);
  const preview = el("section", { class: "vault-preview", "aria-label": t("File preview", "Dateivorschau") }, previewHeader, previewBody);
  const explorer = el("div", { class: "vault-explorer", hidden: true }, columns, preview);
  const browser = el("section", { class: "panel vault-browser", "aria-label": t("Vault file manager", "Vault-Dateimanager") }, toolbar, feedback, explorer);
  const page = el("section", { class: "secondary-page vault-page", "aria-labelledby": "vault-heading" }, browser, transfers);
  const menu = el("div", { class: "vault-context-menu", role: "menu", hidden: true, "aria-label": t("File actions", "Dateiaktionen") });
  page.append(menu);
  let snapshot = { entries: [], receivedEntries: [], enabled: false };
  let model = buildModel(snapshot);
  let navigation = ["root"];
  let view = vaultExplorerView(model, navigation);
  let columnLimit = 3;
  let parentId = null, generation = 0, uploading = false;
  let previewRef = null, previewSession = null, previewScope = null, previewLoading = false, previewFingerprint = "", previewRequest = 0;
  let discardPrompt = null;
  let menuRef = null, menuTrigger = null, activeDrag = null, suppressClickUntil = 0, moving = false;
  const dragScope = crypto.randomUUID();
  const dragType = "application/x-zelotez-vault-entry";
  const columnNodes = new Map();
  const jobs = new Set(), queue = [];
  let ownedDialog = null, refreshNative = () => {};
  const desktop = globalThis.roomsVault;
  const integration = desktop ? desktopPanel() : null;

  function current() { return !signal.aborted; }
  function buildModel(value) {
    return createVaultExplorerModel(value, { actorId: user.id, rootName: t("Files", "Dateien"),
      sharedName: t("Shared With Me", "Mit mir geteilt"), unknownSenderName: t("Unknown sender", "Unbekannter Absender"),
      lockedName: t("Encrypted item", "Verschlüsseltes Element") });
  }
  function vaultDialog(title, content) { closeMenu(); ownedDialog = content; showDialog(title, content); }
  function report(error) { if (current() && error?.name !== "AbortError") notify(error.message || t("The vault request failed.", "Die Vault-Anfrage ist fehlgeschlagen.")); }
  function activeFolderRef() { return view.selected?.ref ?? "root"; }
  function ownDestination(ref) {
    const node = model.node(ref);
    if (ref === "root") return { parentId: null };
    if (!node?.entry || !node.container || node.readOnly || node.locked || node.entry.ownerId !== user.id) return null;
    return { parentId: node.entry.id };
  }
  function openSettings() {
    const content = el("div", { class: "stack vault-settings-dialog" },
      el("p", { class: "muted" }, t("Private files. Encrypted before upload.", "Private Dateien. Vor dem Upload verschlüsselt.")),
      el("p", { class: "subtle" }, t("File names and contents are encrypted on your device. Keep access to your account keys; the operator cannot recover your files without them.",
        "Dateinamen und Inhalte werden auf deinem Gerät verschlüsselt. Bewahre den Zugang zu deinen Kontoschlüsseln: Der Betreiber kann deine Dateien ohne sie nicht wiederherstellen.")), integration);
    vaultDialog(t("Vault settings", "Vault-Einstellungen"), content);
  }
  function fingerprint(entry) { return JSON.stringify([entry?.id, entry?.receivedShareId, entry?.envelope, entry?.descriptor]); }
  function confirmDiscard() {
    if (!current()) return false;
    if (discardPrompt) return discardPrompt.promise;
    const dialog = el("dialog", { class: "dialog vault-discard-dialog", "aria-labelledby": "vault-discard-heading" });
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const finish = accepted => {
      if (discardPrompt?.dialog !== dialog) return;
      discardPrompt = null; signal.removeEventListener("abort", aborted);
      if (dialog.open) dialog.close(); dialog.remove(); resolve(accepted);
    };
    const aborted = () => finish(false);
    const keep = button(t("Keep editing", "Weiter bearbeiten"), () => finish(false), { class: "primary" });
    dialog.append(el("div", { class: "dialog-body" },
      el("h2", { id: "vault-discard-heading" }, t("Discard unsaved changes?", "Ungespeicherte Änderungen verwerfen?")),
      el("p", { class: "muted" }, t("Your changes are only on this device until you save an encrypted copy.",
        "Deine Änderungen bleiben auf diesem Gerät, bis du eine verschlüsselte Kopie speicherst.")),
      el("div", { class: "inline" }, keep, button(t("Discard changes", "Änderungen verwerfen"), () => finish(true), { class: "danger" }))));
    discardPrompt = { dialog, promise, cancel: () => finish(false) }; page.append(dialog);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    signal.addEventListener("abort", aborted, { once: true });
    dialog.showModal(); keep.focus(); return promise;
  }
  async function closePreview(force = false) {
    if (force) discardPrompt?.cancel();
    const closing = previewSession;
    if (!force && closing && !await closing.canClose()) return false;
    if (closing !== previewSession) return previewSession === null;
    previewSession = null; previewRef = null;
    closing?.dispose(); previewScope?.abort(); previewScope = null;
    previewFingerprint = ""; previewLoading = false; previewHeader.hidden = true;
    previewBody.replaceChildren(previewEmpty); previewTitle.textContent = ""; previewPath.textContent = "";
    paintSelection(); return true;
  }
  async function openFile(ref) {
    const node = model.node(ref);
    if (!current() || !node?.entry || node.container || node.locked) return;
    closeMenu();
    if (previewRef === ref && previewSession && !previewSession.closed) return;
    const request = ++previewRequest;
    if (!await closePreview() || request !== previewRequest || !current()) return;
    const fresh = model.node(ref);
    if (!fresh?.entry || fresh.container || fresh.locked) return;
    previewRef = ref; previewScope = new AbortController();
    const lifetime = AbortSignal.any([signal, previewScope.signal]);
    previewLoading = true; previewFingerprint = fingerprint(fresh.entry);
    const sessionClient = Object.create(client);
    const currentEntry = () => {
      const latest = model.node(ref);
      if (!latest?.entry || latest.locked || latest.container) throw new Error(t("This vault item is unavailable.", "Dieses Vault-Element ist nicht verfügbar."));
      return latest.entry;
    };
    sessionClient.saveEditedCopy = (_entry, blob, options) => client.saveEditedCopy(currentEntry(), blob, options);
    sessionClient.download = (_entry, options) => client.download(currentEntry(), options);
    if (client.prepareDownload) sessionClient.prepareDownload = (_entry, options) => client.prepareDownload(currentEntry(), options);
    sessionClient.upload = (file, _destination, options) => {
      const latest = currentEntry();
      return client.upload(file, latest.receivedShareId ? null : latest.parentId ?? null, options);
    };
    const session = mountVaultEditor({ entry: fresh.entry, client: sessionClient, signal: lifetime, externalHeader: true, confirmDiscard,
      onSaved: async () => { await refresh(); },
      onClose: () => { if (previewSession === session) closePreview(true); },
      ...(canShareVaultPlayback(fresh.entry, user) ? { onShare: () => sharePlayback(model.node(ref)?.entry) } : {}) });
    previewSession = session; previewHeader.hidden = false; previewBody.replaceChildren(session.node);
    paintPreviewHeading(); paintSelection();
    void Promise.resolve(session.ready).catch(report).finally(() => { if (previewSession === session) previewLoading = false; });
  }
  function paintPreviewHeading() {
    const node = model.node(previewRef);
    if (!node || !previewSession) return;
    previewTitle.textContent = node.name; previewTitle.title = node.name;
    previewPath.textContent = model.path(previewRef).slice(0, -1).map(item => item.name).join(" / ");
    previewPath.title = previewPath.textContent;
    previewShared.hidden = !node.readOnly;
  }
  function reconcilePreview() {
    if (!previewRef) return;
    const node = model.node(previewRef);
    if (!snapshot.enabled || !node?.entry || node.locked || node.container) { closePreview(true); return; }
    if (previewLoading && previewFingerprint !== fingerprint(node.entry)) {
      const ref = previewRef; closePreview(true); openFile(ref); return;
    }
    paintPreviewHeading();
  }
  function sharePlayback(entry) { if (entry) return openVaultRoomShare({ entry, client, user, signal }).catch(report); }
  function fileKind(entry) { const kind = vaultFileKind(entry); return kind === "other" ? "file" : kind; }
  function entryIcon(node) {
    const kind = node.locked ? "locked" : node.ref === "shared" ? "shared" : node.synthetic ? "sender" : node.container ? "folder" : fileKind(node.entry);
    const paths = {
      folder: ["M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"],
      shared: ["M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z", "M9 14h6m-3-3 3 3-3 3"],
      sender: ["M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"],
      locked: ["M6 11h12v10H6Z", "M8 11V7a4 4 0 0 1 8 0v4m-4 4v2"],
      image: ["M4 4h16v16H4Z", "M4 16l5-5 4 4 3-3 4 4", "M16 8h.01"],
      video: ["M4 4h16v16H4Z", "m10 8 6 4-6 4Z"],
      audio: ["M9 17V5l11-2v12", "M9 14c-6-1-7 6-2 6 2 0 2-2 2-3m11-5c-6-1-7 6-2 6 2 0 2-2 2-3"],
      pdf: ["M5 3h9l5 5v13H5Z", "M14 3v5h5M8 13h8m-8 4h6"],
      text: ["M5 3h9l5 5v13H5Z", "M14 3v5h5M8 12h8m-8 4h8"],
      office: ["M4 4h16v16H4Z", "M4 9h16M4 14h16M10 9v11"],
      archive: ["M5 3h14v18H5Z", "M11 3v2h2v2h-2v2h2v2h-2v2m0 3h2v3h-2Z"],
      file: ["M5 3h9l5 5v13H5Z", "M14 3v5h5"],
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    for (const d of paths[kind] ?? paths.file) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d); svg.append(path);
    }
    return svg;
  }
  function entryName(entry) { return entry.name || t("Encrypted item", "Verschlüsseltes Element"); }
  function isFolder(entry) { return entry.kind === "folder"; }
  function parentOptions(excluded = new Set()) {
    return [["", t("Files", "Dateien")], ...snapshot.entries.filter(entry => isFolder(entry) && !excluded.has(entry.id) && !entry.locked)
      .map(entry => [entry.id, folderPath(entry)])];
  }
  function folderPath(entry) {
    const node = model.node("own:" + entry.id);
    return node ? model.path(node.ref).slice(1).map(item => item.name).join(" / ") : entryName(entry);
  }
  function openFolder(ref, focus = false) {
    const node = model.node(ref);
    if (!node?.container || node.locked) return;
    closeMenu(); navigation = navigateVaultExplorer(model, navigation, ref); search.value = "";
    paint();
    const list = columnNodes.get(ref)?.list;
    list?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    if (focus) (list?.querySelector(".vault-entry-hit") ?? list)?.focus({ preventScroll: true });
  }
  function paintBreadcrumbs() {
    const crumb = node => { const control = button(node.name, () => openFolder(node.ref, true),
      { class: "ghost", title: node.name, "aria-current": node.ref === activeFolderRef() ? "page" : null });
      bindDrop(control, node.ref); return el("li", {}, control); };
    const separator = () => el("li", { class: "vault-path-separator", "aria-hidden": "true" }, "›");
    const chain = view.breadcrumbs;
    const parts = [crumb(chain[0])];
    if (chain.length > 4) {
      parts.push(separator(), el("li", {}, el("details", { class: "vault-path-overflow" },
        el("summary", { class: "button ghost", "aria-label": t("Parent folders", "Übergeordnete Ordner") }, "…"),
        el("div", { class: "vault-path-ancestors" }, chain.slice(1, -2).map(node => button(node.name, () => openFolder(node.ref, true), { class: "ghost" }))))));
    }
    for (const node of chain.length > 4 ? chain.slice(-2) : chain.slice(1)) parts.push(separator(), crumb(node));
    breadcrumbList.replaceChildren(...parts); breadcrumbs.title = chain.map(node => node.name).join(" / ");
  }
  function sortedItems(items, ref) {
    const query = ref === activeFolderRef() ? search.value.trim().toLocaleLowerCase(locale()) : "";
    return items.filter(node => !query || node.name.toLocaleLowerCase(locale()).includes(query)).sort((a, b) =>
      Number(b.ref === "shared") - Number(a.ref === "shared") || Number(b.container) - Number(a.container) || (sorting.value === "date" ? new Date(b.entry?.updatedAt ?? 0) - new Date(a.entry?.updatedAt ?? 0)
        : sorting.value === "size" ? (b.entry?.plainBytes ?? b.entry?.size ?? 0) - (a.entry?.plainBytes ?? a.entry?.size ?? 0)
          : a.name.localeCompare(b.name, locale(), { numeric: true })));
  }
  function paint() {
    if (!current()) return;
    closeMenu(); columnLimit = visibleColumnLimit();
    view = vaultExplorerView(model, navigation, { maxColumns: columnLimit }); navigation = view.path;
    const enabled = snapshot.enabled === true;
    parentId = ownDestination(activeFolderRef())?.parentId ?? null;
    refreshNative(); toolbar.hidden = !enabled; explorer.hidden = !enabled; quota.hidden = !enabled; breadcrumbs.hidden = !enabled;
    const writable = enabled && !!ownDestination(activeFolderRef());
    upload.disabled = !writable; newFolder.disabled = !writable; search.disabled = !enabled; sorting.disabled = !enabled;
    refreshButton.disabled = false;
    if (!enabled) { columns.replaceChildren(); columnNodes.clear(); closePreview(true);
      tell(feedback, t("ZeloteZ Vault is not enabled on this instance.", "ZeloteZ Vault ist auf dieser Instanz nicht aktiviert.")); return; }
    const used = Number(snapshot.usedBytes) || 0, reserved = Number(snapshot.reservedBytes) || 0, limit = Math.max(0, Number(snapshot.quotaBytes) || 0);
    quotaLabel.textContent = t("{used} of {limit} used", "{used} von {limit} belegt", { used: vaultBytes(used), limit: vaultBytes(limit) })
      + (reserved ? " · " + t("{size} uploading", "{size} im Upload", { size: vaultBytes(reserved) }) : "");
    quota.title = quotaLabel.textContent; quotaBar.max = Math.max(1, limit); quotaBar.value = Math.min(used + reserved, limit);
    paintBreadcrumbs();
    const activeCount = sortedItems(model.children(activeFolderRef()), activeFolderRef()).length;
    folderStatus.textContent = t("{count} items", "{count} Elemente", { count: activeCount });
    const keep = new Set(view.columns.map(column => column.ref));
    for (const [ref, value] of columnNodes) if (!keep.has(ref)) { value.node.remove(); columnNodes.delete(ref); }
    for (const column of view.columns) {
      let value = columnNodes.get(column.ref);
      if (!value) {
        const title = el("h2", { class: "vault-column-title" });
        const count = el("span", { class: "vault-column-count subtle" });
        const up = button("↑", () => {
          const fresh = model.node(column.ref); if (fresh?.parentRef) openFolder(fresh.parentRef, true);
        }, { class: "ghost icon-button", "aria-label": t("Parent folder", "Übergeordneter Ordner"), title: t("Parent folder", "Übergeordneter Ordner") });
        const list = el("div", { class: "vault-column-entries", role: "list", tabindex: 0 });
        const empty = el("p", { class: "vault-column-empty subtle", hidden: true });
        const heading = el("header", { class: "vault-column-heading" }, el("div", {}, title, count), up);
        const node = el("section", { class: "vault-column", "data-folder-ref": column.ref }, heading, list, empty);
        list.addEventListener("keydown", event => columnKey(event, column.ref));
        node.addEventListener("contextmenu", event => { if (!event.target.closest(".vault-entry")) { event.preventDefault(); openBlankMenu(column.ref, event); } });
        bindDrop(node, column.ref); value = { node, title, count, up, list, empty }; columnNodes.set(column.ref, value);
      }
      value.title.textContent = column.node.name; value.title.title = model.path(column.ref).map(item => item.name).join(" / ");
      value.node.setAttribute("aria-label", value.title.title); value.up.hidden = column.ref === "root";
      const items = sortedItems(column.items, column.ref), scroll = value.list.scrollTop;
      const focused = value.list.contains(document.activeElement) ? document.activeElement.closest("[data-vault-ref]")?.dataset.vaultRef : null;
      value.list.replaceChildren(...items.map(node => entryRow(node, column)));
      value.list.scrollTop = scroll; value.count.textContent = t("{count} items", "{count} Elemente", { count: items.length });
      value.empty.hidden = !!items.length; value.empty.textContent = search.value && column.ref === activeFolderRef()
        ? t("No matching files", "Keine passenden Dateien") : t("This folder is empty", "Dieser Ordner ist leer");
      const columnIndex = view.columns.indexOf(column);
      if (value.node !== columns.children[columnIndex]) columns.insertBefore(value.node, columns.children[columnIndex] ?? null);
      if (focused) [...value.list.querySelectorAll(".vault-entry-hit")].find(hit => hit.closest("[data-vault-ref]")?.dataset.vaultRef === focused)?.focus({ preventScroll: true });
    }
    columns.style.setProperty("--vault-columns", view.columns.length);
    reconcilePreview(); paintSelection();
  }
  function paintSelection() {
    for (const row of columns.querySelectorAll(".vault-entry")) {
      const ref = row.dataset.vaultRef;
      const selected = view.columns.some(column => column.selectedRef === ref) || previewRef === ref;
      row.dataset.selected = String(selected);
      row.querySelector(".vault-entry-hit")?.setAttribute("aria-pressed", String(selected));
    }
  }
  function entryRow(node, column) {
    const entry = node.entry, locked = node.locked, shared = node.readOnly && node.ref !== "root";
    const details = node.synthetic ? (node.ref === "shared" ? t("Shared files", "Geteilte Dateien") : t("Shared by {name}", "Geteilt von {name}", { name: node.name }))
      : locked ? t("This item could not be decrypted.", "Dieses Element konnte nicht entschlüsselt werden.")
        : node.container ? t("Folder", "Ordner") : vaultBytes(entry?.plainBytes ?? entry?.size);
    const hit = button("", () => { if (Date.now() < suppressClickUntil) return; node.container ? openFolder(node.ref) : openFile(node.ref); },
      { class: "ghost vault-entry-hit", disabled: locked, "aria-label": node.name, "aria-pressed": "false", title: node.name });
    hit.append(...[el("span", { class: "vault-entry-icon", "aria-hidden": "true", "data-kind": node.container ? "folder" : fileKind(entry) },
      entryIcon(node)),
      el("span", { class: "vault-entry-title" }, el("span", { class: "vault-entry-name" }, node.name), el("span", { class: "subtle" }, details)),
      shared && el("span", { class: "vault-shared-mark", title: t("Shared", "Geteilt"), "aria-label": t("Shared", "Geteilt") }, "↗"),
      node.container && el("span", { class: "vault-entry-arrow", "aria-hidden": "true" }, "›")].filter(Boolean));
    const actions = button("⋯", event => openNodeMenu(node.ref, event.currentTarget),
      { class: "ghost vault-entry-more", "aria-haspopup": "menu", "aria-label": t("Actions for {name}", "Aktionen für {name}", { name: node.name }) });
    const row = el("div", { class: "vault-entry", role: "listitem", "data-vault-ref": node.ref, "data-vault-id": entry?.uiId || entry?.id || node.ref }, hit, actions);
    row.addEventListener("click", event => { if (!event.target.closest("button,a,input,select,textarea") && !locked && Date.now() >= suppressClickUntil)
      node.container ? openFolder(node.ref) : openFile(node.ref); });
    row.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); openNodeMenu(node.ref, hit, event); });
    const movable = !!entry && !node.readOnly && !locked && entry.ownerId === user.id && entry.state === "ready";
    row.draggable = movable;
    row.addEventListener("dragstart", event => {
      if (!movable || moving || !event.dataTransfer) { event.preventDefault(); return; }
      closeMenu(); activeDrag = { ref: node.ref, scope: dragScope }; event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(dragType, JSON.stringify(activeDrag)); row.classList.add("vault-drag-source");
    });
    row.addEventListener("dragend", () => { activeDrag = null; suppressClickUntil = Date.now() + 250; clearDropStates(); row.classList.remove("vault-drag-source"); });
    if (node.container) bindDrop(row, node.ref);
    return row;
  }
  function columnKey(event, ref) {
    if (event.altKey || event.ctrlKey || event.metaKey || !event.target.matches(".vault-entry-hit")) return;
    const value = columnNodes.get(ref), hits = [...value.list.querySelectorAll(".vault-entry-hit:not(:disabled)")], index = hits.indexOf(event.target);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); hits[event.key === "Home" ? 0 : event.key === "End" ? hits.length - 1 : Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (event.key === "ArrowRight") {
      const node = model.node(event.target.closest("[data-vault-ref]")?.dataset.vaultRef);
      event.preventDefault(); if (node?.container) openFolder(node.ref, true); else if (node) { openFile(node.ref); previewTitle.focus({ preventScroll: true }); }
    } else if (event.key === "ArrowLeft") {
      const index = view.columns.findIndex(column => column.ref === ref), previous = view.columns[index - 1];
      if (previous) { event.preventDefault(); const list = columnNodes.get(previous.ref)?.list;
        (list?.querySelector('.vault-entry[data-selected="true"] .vault-entry-hit') ?? list?.querySelector(".vault-entry-hit"))?.focus({ preventScroll: true }); }
    } else if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); openNodeMenu(event.target.closest("[data-vault-ref]")?.dataset.vaultRef, event.target); }
  }
  function closeMenu(focus = false) {
    menu.hidden = true; menu.replaceChildren();
    for (const row of columns.querySelectorAll('[data-context="true"]')) delete row.dataset.context;
    if (focus && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
    menuRef = null; menuTrigger?.setAttribute("aria-expanded", "false"); menuTrigger = null;
  }
  function positionMenu(trigger, point) {
    menu.hidden = false;
    const box = trigger?.getBoundingClientRect(), width = Math.min(218, innerWidth - 20);
    menu.style.inlineSize = width + "px";
    const x = point?.clientX ?? (box ? box.right - width : 10), y = point?.clientY ?? (box ? box.bottom + 5 : 10);
    menu.style.left = Math.max(10, Math.min(innerWidth - width - 10, x)) + "px";
    menu.style.top = Math.max(10, Math.min(innerHeight - menu.getBoundingClientRect().height - 10, y)) + "px";
  }
  function menuAction(label, action, disabled = false, danger = false) {
    return button(label, () => { closeMenu(); action(); }, { role: "menuitem", disabled, class: danger ? "danger" : "ghost" });
  }
  function openNodeMenu(ref, trigger, point) {
    const node = model.node(ref); if (!node) return;
    if (!point && !menu.hidden && menuRef === ref) { closeMenu(true); return; }
    closeMenu(); menuRef = ref; menuTrigger = trigger; trigger?.setAttribute("aria-expanded", "true");
    const action = fn => { const fresh = model.node(ref); if (fresh) fn(fresh); };
    const entry = node.entry;
    menu.replaceChildren(...[menuAction(node.container ? t("Open folder", "Ordner öffnen") : t("Open", "Öffnen"), () => action(fresh => fresh.container ? openFolder(ref) : openFile(ref)), node.locked),
      entry && !node.container && menuAction(t("Download", "Herunterladen"), () => action(fresh => download(fresh.entry)), node.locked),
      entry && canShareVaultPlayback(entry, user) && menuAction(t("Play in a room", "In einem Raum abspielen"), () => action(fresh => void sharePlayback(fresh.entry))),
      entry && !node.readOnly && menuAction(t("Rename", "Umbenennen"), () => action(fresh => editName(fresh.entry)), node.locked),
      entry && !node.readOnly && menuAction(t("Move", "Verschieben"), () => action(fresh => moveEntry(fresh.entry)), node.locked || moving),
      entry && !node.readOnly && !node.container && menuAction(t("Share", "Teilen"), () => action(fresh => shareEntry(fresh.entry)), node.locked),
      entry && !node.readOnly && menuAction(t("Delete", "Löschen"), () => action(fresh => deleteEntry(fresh.entry)), false, true)].filter(Boolean));
    const row = [...columns.querySelectorAll(".vault-entry")].find(item => item.dataset.vaultRef === ref); if (row) row.dataset.context = "true";
    positionMenu(trigger, point); if (!point) menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  function openBlankMenu(ref, point) {
    if (!ownDestination(ref)) return;
    closeMenu(); menuRef = ref;
    menu.replaceChildren(menuAction(t("Upload files", "Dateien hochladen"), () => pickFiles(ref)),
      menuAction(t("New folder", "Neuer Ordner"), () => editName(undefined, ref)), menuAction(t("Refresh", "Aktualisieren"), () => refresh()));
    positionMenu(null, point);
  }
  function pickFiles(ref) {
    const destination = ownDestination(ref); if (!destination) return;
    pickerDestination = destination.parentId; picker.click();
  }
  function clearDropStates() { for (const item of page.querySelectorAll(".vault-drop-active")) item.classList.remove("vault-drop-active"); }
  function internalDrag(event) { return activeDrag?.scope === dragScope && Array.from(event.dataTransfer?.types ?? []).includes(dragType); }
  function bindDrop(target, ref) {
    target.addEventListener("dragover", event => {
      if (!snapshot.enabled || moving) return;
      const internal = internalDrag(event), external = Array.from(event.dataTransfer?.types ?? []).includes("Files");
      if (!internal && !external) return;
      const allowed = internal ? validateVaultExplorerMove(model, activeDrag.ref, ref, { actorId: user.id }).ok : !!ownDestination(ref);
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = allowed ? internal ? "move" : "copy" : "none";
      target.classList.toggle("vault-drop-active", allowed);
    });
    target.addEventListener("dragleave", event => { if (!target.contains(event.relatedTarget)) target.classList.remove("vault-drop-active"); });
    target.addEventListener("drop", event => {
      const internal = internalDrag(event), external = Array.from(event.dataTransfer?.types ?? []).includes("Files");
      if (!internal && !external) return;
      event.preventDefault(); event.stopPropagation(); clearDropStates();
      if (internal) {
        let payload; try { payload = JSON.parse(event.dataTransfer.getData(dragType)); } catch { return; }
        if (payload?.scope !== dragScope || payload.ref !== activeDrag.ref) return;
        const sourceRef = activeDrag.ref; activeDrag = null; suppressClickUntil = Date.now() + 250;
        void performMove(sourceRef, ref);
      } else {
        const destination = ownDestination(ref); if (!destination) return;
        const directory = Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory);
        if (directory) { notify(t("Use the desktop app’s file manager integration to upload folders.", "Nutze die Dateimanager-Integration der Desktop-App, um Ordner hochzuladen.")); return; }
        addFiles(event.dataTransfer.files ?? [], destination.parentId);
      }
    });
  }
  async function performMove(sourceRef, destinationRef) {
    if (!current() || moving) return;
    const checked = validateVaultExplorerMove(model, sourceRef, destinationRef, { actorId: user.id });
    if (!checked.ok) { notify(t("This item cannot be moved to that folder.", "Dieses Element kann nicht in diesen Ordner verschoben werden.")); return; }
    moving = true;
    try {
      await client.move(checked.entry, checked.parentId, { signal });
      if (current()) { await refresh(); notify(t("Item moved.", "Element verschoben.")); }
    } catch (error) { report(error); }
    finally { moving = false; }
  }
  async function refresh() {
    const request = ++generation;
    refreshButton.disabled = true;
    try {
      const result = await client.list({ signal });
      if (!current() || generation !== request) return;
      snapshot = { ...result, entries: Array.isArray(result.entries) ? result.entries : [], receivedEntries: Array.isArray(result.receivedEntries) ? result.receivedEntries : [] };
      model = buildModel(snapshot);
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
  function editName(entry, folderRef = activeFolderRef()) {
    if (entry) nameDialog(t("Rename item", "Element umbenennen"), entryName(entry), name => client.rename(entry, name, { signal }));
    else {
      const target = ownDestination(folderRef); if (!target) return;
      nameDialog(t("New folder", "Neuer Ordner"), "", name => client.createFolder(target.parentId, name, { signal }));
    }
  }
  function moveEntry(entry) {
    const destination = select(parentOptions(vaultDescendants(snapshot.entries, entry.id)), entry.parentId ?? "");
    const content = form(field(t("Destination folder", "Zielordner"), destination), t("Move", "Verschieben"), async () => {
      const ref = destination.value ? "own:" + destination.value : "root";
      const checked = validateVaultExplorerMove(model, "own:" + entry.id, ref, { actorId: user.id });
      if (!checked.ok) throw new Error(t("This item cannot be moved to that folder.", "Dieses Element kann nicht in diesen Ordner verschoben werden."));
      await client.move(checked.entry, checked.parentId, { signal });
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
      const affected = vaultDescendants(snapshot.entries, entry.id);
      if (previewRef && affected.has(model.node(previewRef)?.entry?.id) && !await closePreview()) return;
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
  function addFiles(files, destination = parentId) {
    if (!snapshot.enabled || !current()) return;
    for (const file of files) queue.push({ file, destination });
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
  search.addEventListener("input", paint);
  sorting.addEventListener("change", paint);
  picker.addEventListener("change", () => { addFiles(picker.files ?? [], pickerDestination); picker.value = ""; });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target) && !menuTrigger?.contains(event.target)) closeMenu();
  }, { signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); closeMenu(true); } }, { signal });
  menu.addEventListener("keydown", event => {
    const controls = [...menu.querySelectorAll("button:not(:disabled)")], index = controls.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      controls[event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + controls.length + (event.key === "ArrowDown" ? 1 : -1)) % controls.length]?.focus();
    } else if (event.key === "Tab") closeMenu();
  });
  columns.addEventListener("scroll", () => closeMenu(), { capture: true, passive: true });
  const toast = document.querySelector("#toast");
  function visibleColumnLimit() {
    const width = explorer.clientWidth;
    if (!width) return 3;
    const share = Number(getComputedStyle(columns).getPropertyValue("--vault-columns-share")) || .64;
    return Math.max(1, Math.min(3, Math.floor((width * share - 1) / 180)));
  }
  function fitViewport() {
    if (!current()) return;
    closeMenu();
    if (snapshot.enabled && visibleColumnLimit() !== columnLimit) paint();
    if (toast) page.style.setProperty("--vault-toast-offset", toast.hidden ? "0px" : toast.getBoundingClientRect().height + 10 + "px");
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fitViewport) : null;
  if (toast) observer?.observe(toast);
  observer?.observe(explorer);
  globalThis.addEventListener?.("resize", fitViewport, { signal });
  globalThis.addEventListener?.("beforeunload", event => {
    if (previewSession?.dirty) { event.preventDefault(); event.returnValue = ""; }
  }, { signal });
  signal.addEventListener("abort", () => {
    observer?.disconnect(); closeMenu(); activeDrag = null; closePreview(true);
    queue.length = 0; for (const job of jobs) job.abort();
    if (ownedDialog?.isConnected) closeDialog();
    snapshot = { entries: [], enabled: false }; client.close?.();
  }, { once: true });
  paintBreadcrumbs();
  void refresh();
  return { node: page, header: banner, canLeave: () => previewSession?.canClose() ?? true };
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
