"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createVaultIntegration, label } = require("./vault-integration.cjs");
const { parseVaultArguments, planSelection, createVaultSelection, MAX_SELECTION, MAX_READ_BYTES, MAX_ARCHIVE_BYTES } = require("./vault-archive.cjs");
const { createVaultSave, validateDownload } = require("./vault-save.cjs");

async function planSingleSelection(selected, options) {
  // Older instance pages understand one source only. Never silently combine
  // separate files into a ZIP, or upload just the first item of a selection.
  if (selected.length !== 1) throw Object.assign(new Error("Update the Rooms instance."), { code: "VAULT_SERVER_UPDATE_REQUIRED" });
  return planSelection(selected, options);
}
async function createSingleSelection(plan, options) { return (await createVaultSelection(plan, options))[0]; }

function installVaultIpc({ ipcMain, dialog, allowed, current, text = en => en, platform = process.platform,
  env = process.env, executable = process.execPath, packaged = () => true, initialArgs = process.argv, cwd = process.cwd(),
  integration = createVaultIntegration({ platform, env, executable }), planner = planSingleSelection, createArchive = createSingleSelection,
  selectionPlanner = planSelection, createSelection = createVaultSelection, createSave = createVaultSave }) {
  let pending = parseVaultArguments(initialArgs, cwd, platform), revision = 0, archive = null, binding = null, preparing = null;
  let integrationChanging = false, nativeReading = false;
  let save = null, saveBinding = null, savePreparing = null, downloadRevision = 0, saveCleanup = null;
  let lastBusyNotice = 0, announcementTimer = null;
  const settling = new Set();
  function settled() { return announcementTimer === null ? Promise.resolve() : new Promise(resolve => settling.add(resolve)); }
  function finishSettling() { for (const resolve of settling) resolve(); settling.clear(); }
  function queueAnnounce() {
    clearTimeout(announcementTimer);
    announcementTimer = setTimeout(() => { announcementTimer = null; finishSettling(); announce(); }, 250);
    announcementTimer.unref?.();
  }
  const nativePath = platform === "win32" ? path.win32 : path;
  const safeError = () => new Error(text("The local Vault operation failed or the selected files changed. Select them again and retry.",
    "Der lokale Vault-Vorgang ist fehlgeschlagen oder die Auswahl wurde verändert. Wähle sie erneut aus und versuche es noch einmal.",
    "本地 Vault 操作失败或所选文件已更改。请重新选择后重试。"));
  function operationError(error) {
    const messages = {
      VAULT_UNREADABLE: ["A selected file or folder is unavailable or cannot be read. Check its location and access permissions.",
        "Eine ausgewählte Datei oder ein Ordner ist nicht verfügbar oder kann nicht gelesen werden. Prüfe Speicherort und Zugriffsrechte.",
        "所选文件或文件夹不可用或无法读取。请检查位置和访问权限。"],
      VAULT_SELECTION_CHANGED: ["The selected files changed during preparation or transfer. Select them again and retry.",
        "Die ausgewählten Dateien wurden während der Vorbereitung oder Übertragung verändert. Wähle sie erneut aus.",
        "所选文件在准备或传输期间发生了变化。请重新选择后重试。"],
      VAULT_INVALID_NAME: ["The selection contains a name that cannot be transferred safely. Rename it and retry.",
        "Die Auswahl enthält einen Namen, der nicht sicher übertragen werden kann. Benenne ihn um und versuche es erneut.",
        "所选内容包含无法安全传输的名称。请重命名后重试。"],
      VAULT_SYMLINK: ["Symbolic links and special files cannot be archived. Select regular files or folders instead.",
        "Symbolische Links und Spezialdateien können nicht archiviert werden. Wähle reguläre Dateien oder Ordner.",
        "无法归档符号链接或特殊文件。请选择普通文件或文件夹。"],
      VAULT_LIMIT: ["The selection exceeds the archive limits. Select fewer files or a smaller folder.",
        "Die Auswahl überschreitet die Archivgrenzen. Wähle weniger Dateien oder einen kleineren Ordner.",
        "所选内容超出归档限制。请选择更少的文件或更小的文件夹。"],
      VAULT_ARCHIVE_FAILED: ["The local files could not be prepared. Select them again or restart the desktop app.",
        "Die lokalen Dateien konnten nicht vorbereitet werden. Wähle sie erneut aus oder starte die Desktop-App neu.",
        "无法准备本地文件。请重新选择文件或重启桌面应用。"],
      VAULT_SERVER_UPDATE_REQUIRED: ["Update your Rooms instance to transfer multiple selected items separately. No files have been uploaded.",
        "Aktualisiere deine Rooms-Instanz, um mehrere ausgewählte Elemente einzeln zu übertragen. Es wurden keine Dateien hochgeladen.",
        "请更新 Rooms 实例，以分别传输多个所选项目。尚未上传任何文件。"],
      VAULT_CONFIRM_FAILED: ["The file confirmation could not be opened. Restart the desktop app and retry.",
        "Die Dateibestätigung konnte nicht geöffnet werden. Starte die Desktop-App neu und versuche es erneut.",
        "无法打开文件确认窗口。请重启桌面应用后重试。"],
    };
    return Object.hasOwn(messages, error?.code ?? "") ? new Error(text(...messages[error.code])) : safeError();
  }
  function selection() {
    return pending?.length ? { available: true, count: pending.length } : null;
  }
  function same(before, event) {
    const now = current();
    return allowed(event) && before?.contents === now?.contents && before?.origin === now?.origin && before?.window === now?.window;
  }
  async function reset({ keepPending = false } = {}) {
    revision += 1;
    if (!keepPending) { pending = null; clearTimeout(announcementTimer); announcementTimer = null; finishSettling(); }
    preparing?.abort(); preparing = null;
    const previous = archive; archive = null; binding = null;
    await Promise.allSettled([previous?.cancel(), cancelSave()]);
  }
  function announce() {
    const context = current();
    if (announcementTimer === null && pending?.length && context?.active && context.contents && !context.contents.isDestroyed()) {
      context.contents.send("rooms:vault-pending", selection());
    }
  }
  function receiveFiles(files) {
    if (!files) return false;
    if (archive || preparing || save || savePreparing || saveCleanup) {
      const context = current();
      if (Date.now() - lastBusyNotice > 2000 && context?.window) {
        lastBusyNotice = Date.now();
        void dialog.showMessageBox(context.window, { type: "info", noLink: true,
          message: text("A Vault transfer is already in progress.", "Ein Vault-Transfer läuft bereits.", "已有 Vault 传输正在进行。"),
          detail: text("This new selection was not added. Finish or cancel the current transfer, then select the next files again.",
            "Die neue Auswahl wurde nicht hinzugefügt. Beende den laufenden Transfer oder brich ihn ab und wähle danach die nächsten Dateien erneut aus.",
            "未添加此次新选择。请完成或取消当前传输，然后重新选择下一批文件。"),
          buttons: [text("OK", "OK", "确定")],
        }).catch(() => {});
      }
      return true;
    }
    // File managers may launch once per selected item in a short burst. A later
    // context-menu action is a new selection, including after a failed prepare.
    const combined = [...new Set([...(announcementTimer !== null ? pending || [] : []), ...files])];
    if (combined.length > MAX_SELECTION) return false;
    pending = combined;
    void reset({ keepPending: true });
    queueAnnounce();
    return true;
  }
  function receiveArguments(args, directory) { return receiveFiles(parseVaultArguments(args, directory, platform)); }
  function instanceData() { return pending?.length ? { zelotezVault: { v: 1, cwd, paths: [...pending] } } : {}; }
  function receiveInstanceData(input) {
    const value = input?.zelotezVault;
    if (!value || value.v !== 1 || !Array.isArray(value.paths) ||
        Object.keys(value).sort().join(",") !== "cwd,paths,v" ||
        value.paths.some(file => typeof file !== "string" || !nativePath.isAbsolute(file) || nativePath.normalize(file) !== file)) return false;
    return receiveFiles(parseVaultArguments(["--vault-share", "--", ...value.paths], value.cwd, platform));
  }
  async function confirm(context, message, detail) {
    try {
      const result = await dialog.showMessageBox(context.window, {
        type: "question", message, detail, noLink: true, defaultId: 1, cancelId: 1,
        buttons: [text("Continue", "Fortfahren", "继续"), text("Cancel", "Abbrechen", "取消")],
      });
      return result.response === 0;
    } catch { throw Object.assign(new Error("Vault confirmation unavailable."), { code: "VAULT_CONFIRM_FAILED" }); }
  }
  function handle(name, action) {
    ipcMain.handle(name, async (event, ...args) => {
      if (!allowed(event)) return null;
      try { return await action(event, ...args); }
      catch (error) { throw operationError(error); }
    });
  }
  handle("rooms:vault-integration-status", async () => {
    const result = await integration.status();
    return packaged() ? result : { ...result, supported: false };
  });
  async function changeIntegration(event, install) {
    if (!packaged() || integrationChanging) return null;
    const before = current(); integrationChanging = true;
    try {
      const approved = await confirm(before, install
        ? text(`Install “${label}”?`, `„${label}“ installieren?`, `安装“${label}”？`)
        : text(`Remove “${label}”?`, `„${label}“ entfernen?`, `移除“${label}”？`),
      text("This changes only your user account's file-manager context menus. Files are shared only after another confirmation in the app.",
        "Dies ändert nur die Dateimanager-Kontextmenüs deines Benutzerkontos. Dateien werden erst nach einer weiteren Bestätigung in der App geteilt.",
        "这只会更改当前用户的文件管理器右键菜单。文件仍需在应用中再次确认后才会分享。"));
      if (!approved || !same(before, event)) return null;
      return install ? integration.install() : integration.remove();
    } finally { integrationChanging = false; }
  }
  handle("rooms:vault-integration-install", event => changeIntegration(event, true));
  handle("rooms:vault-integration-remove", event => changeIntegration(event, false));
  handle("rooms:vault-pending", async event => { await settled(); return allowed(event) ? selection() : null; });
  const sourceMetadata = source => ({ id: source.id, name: source.name, type: source.type, size: source.size,
    lastModified: Number.isSafeInteger(source.lastModified) && source.lastModified >= 0 ? source.lastModified : 0 });
  async function prepareNative(event, multiple) {
    if (preparing || archive) return null;
    await settled();
    if (!allowed(event) || !pending?.length || preparing || archive) return null;
    const before = current(), selected = [...pending], version = revision, controller = new AbortController();
    preparing = controller;
    try {
      const plan = await (multiple ? selectionPlanner : planner)(selected, { signal: controller.signal });
      if (!same(before, event) || revision !== version || controller.signal.aborted) return null;
      const shown = plan.names.slice(0, 12).join("\n") + (plan.names.length > 12 ? `\n… (+${plan.names.length - 12})` : "");
      const approved = await confirm(before,
        text("Prepare these files for ZeloteZ Vault?", "Diese Dateien für ZeloteZ Vault vorbereiten?", "为 ZeloteZ Vault 准备这些文件？"),
        text("Destination instance: ", "Zielinstanz: ", "目标实例：") + before.origin + "\n\n" + shown + "\n\n" +
        text("Files keep their original names and are encrypted on this device before upload. Only folders become separate ZIPs named after the folder. No plaintext ZIP is saved. Keep the selection unchanged until the transfer finishes.",
          "Dateien behalten ihre Namen und werden auf diesem Gerät vor dem Upload verschlüsselt. Nur Ordner werden zu einzelnen ZIPs mit dem Ordnernamen. Es wird kein unverschlüsseltes ZIP gespeichert. Verändere die Auswahl bis zum Transferende nicht.",
          "文件保留原名，并在此设备上加密后上传。只有文件夹会分别打包为以文件夹命名的 ZIP，不会保存明文 ZIP。传输完成前请勿更改所选内容。"));
      if (!approved || !same(before, event) || revision !== version || controller.signal.aborted) return null;
      let prepared;
      if (multiple) {
        const sources = await createSelection(plan, { signal: controller.signal });
        prepared = { id: randomUUID(), mode: "selection", sources: new Map(sources.map(source => [source.id, source])),
          cancel: () => Promise.allSettled(sources.map(source => source.cancel())) };
      } else prepared = await createArchive(plan, { signal: controller.signal });
      if (!same(before, event) || revision !== version || controller.signal.aborted) { await prepared.cancel(); return null; }
      archive = prepared; binding = before; pending = null;
      return multiple ? { id: prepared.id, files: [...prepared.sources.values()].map(sourceMetadata) } : sourceMetadata(prepared);
    } finally { if (preparing === controller) preparing = null; }
  }
  handle("rooms:vault-archive-prepare", event => prepareNative(event, false));
  handle("rooms:vault-selection-prepare", event => prepareNative(event, true));
  async function readNative(event, id, offset, length, multiple) {
    const source = archive;
    const item = multiple && source?.mode === "selection" ? source.sources.get(id) : !multiple && source?.mode !== "selection" && source?.id === id ? source : null;
    if (!item || nativeReading || !same(binding, event) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 0 || length > MAX_READ_BYTES || offset + length > MAX_ARCHIVE_BYTES || offset + length > item.size ||
        (length === 0 && (item.size !== 0 || offset !== 0))) throw safeError();
    nativeReading = true;
    try {
      const result = await item.read(offset, length);
      if (archive !== source || !same(binding, event)) { result.fill(0); throw safeError(); }
      return result;
    } finally { nativeReading = false; }
  }
  handle("rooms:vault-archive-read", (event, id, offset, length) => readNative(event, id, offset, length, false));
  handle("rooms:vault-selection-read", (event, id, offset, length) => readNative(event, id, offset, length, true));
  handle("rooms:vault-archive-cancel", async (_event, id) => {
    if (id !== undefined && id !== null && (!archive || archive.id !== id)) return false;
    await reset(); return true;
  });
  handle("rooms:vault-selection-cancel", async (_event, id) => {
    if (id !== undefined && id !== null && (archive?.mode !== "selection" || archive.id !== id)) return false;
    await reset(); return true;
  });
  async function cancelSave() {
    downloadRevision += 1;
    const previous = save; save = null; saveBinding = null;
    if (previous) saveCleanup = Promise.allSettled([saveCleanup, previous.cancel()]);
    const cleanup = saveCleanup;
    await cleanup;
    if (saveCleanup === cleanup) saveCleanup = null;
    return true;
  }
  handle("rooms:vault-download-prepare", async (event, input) => {
    const checked = validateDownload(input);
    if (save || savePreparing || saveCleanup) return null;
    const before = current(), version = downloadRevision, marker = {};
    savePreparing = marker;
    const valid = () => downloadRevision === version && same(before, event);
    try {
      const picked = await dialog.showSaveDialog(before.window, {
        title: text("Save Vault file — ", "Vault-Datei speichern — ", "保存 Vault 文件 — ") + before.origin,
        defaultPath: checked.name,
        properties: ["showOverwriteConfirmation", "createDirectory", "dontAddToRecent"],
      });
      if (picked.canceled || typeof picked.filePath !== "string" || !picked.filePath || !valid() || savePreparing !== marker) return null;
      const prepared = await createSave(picked.filePath, checked.size, { valid });
      if (!valid() || savePreparing !== marker) { await prepared.cancel(); return null; }
      save = prepared; saveBinding = before;
      // Neither the destination directory nor the user-edited local name is
      // exposed to the remote page. It receives only its original name and ID.
      return { id: prepared.id, name: checked.name };
    } finally { if (savePreparing === marker) savePreparing = null; }
  });
  handle("rooms:vault-download-write", async (event, id, offset, bytes) => {
    const source = save;
    if (!source || source.id !== id || !same(saveBinding, event)) throw safeError();
    try {
      await source.write(offset, bytes);
      if (save !== source || !same(saveBinding, event)) throw safeError();
      return true;
    } catch (error) {
      if (save === source) await cancelSave();
      else await source.cancel().catch(() => {});
      throw error;
    }
  });
  handle("rooms:vault-download-complete", async (event, id) => {
    const source = save;
    if (!source || source.id !== id || !same(saveBinding, event)) throw safeError();
    try { return await source.complete(); }
    catch (error) { await source.cancel().catch(() => {}); throw error; }
    finally { if (save === source) { save = null; saveBinding = null; } }
  });
  handle("rooms:vault-download-cancel", async (_event, id) => {
    if (id !== undefined && id !== null && (!save || save.id !== id)) return false;
    return cancelSave();
  });
  if (pending?.length) queueAnnounce();
  return { receiveArguments, receiveInstanceData, instanceData, announce, reset, pending: selection };
}
module.exports = { installVaultIpc };
