"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsDesktop", true);
const vaultUuid = value => typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const vaultOffset = value => Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4;
const vaultInvalid = () => Promise.reject(new Error("Invalid Vault transfer request."));
let vaultReading = false, vaultWriting = false, vaultSaving = false, vaultFinishing = false;
function vaultPrepareDownload(input) {
  if (!navigator.userActivation.isActive) return Promise.resolve(null);
  if (vaultSaving || !input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "name,size" || typeof input.name !== "string" || input.name.length > 255 || !input.name.trim() ||
      /[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(input.name) || /[. ]$/u.test(input.name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(input.name) ||
      new TextEncoder().encode(input.name).byteLength > 255 || !vaultOffset(input.size)) return vaultInvalid();
  vaultSaving = true;
  return ipcRenderer.invoke("rooms:vault-download-prepare", { name: input.name, size: input.size })
    .finally(() => { vaultSaving = false; });
}
function vaultReadArchive(id, offset, length) {
  if (vaultReading || !vaultUuid(id) || !vaultOffset(offset) || !Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 * 1024 || offset + length > 1024 ** 4) return vaultInvalid();
  vaultReading = true;
  return ipcRenderer.invoke("rooms:vault-archive-read", id, offset, length).finally(() => { vaultReading = false; });
}
function vaultWriteDownload(id, offset, input) {
  if (vaultWriting || vaultFinishing || !vaultUuid(id) || !vaultOffset(offset) || (!ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer))) return vaultInvalid();
  let copy;
  try {
    const visible = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (!visible.byteLength || visible.byteLength > 4 * 1024 * 1024 || offset + visible.byteLength > 1024 ** 4) return vaultInvalid();
    copy = Uint8Array.from(visible);
  } catch { return vaultInvalid(); }
  vaultWriting = true;
  return ipcRenderer.invoke("rooms:vault-download-write", id, offset, copy)
    .finally(() => { copy.fill(0); vaultWriting = false; });
}
function vaultCompleteDownload(id) {
  if (vaultWriting || vaultFinishing || !vaultUuid(id)) return vaultInvalid();
  vaultFinishing = true;
  return ipcRenderer.invoke("rooms:vault-download-complete", id).finally(() => { vaultFinishing = false; });
}
function vaultCancelDownload(id) {
  if (id !== undefined && id !== null && !vaultUuid(id)) return vaultInvalid();
  return ipcRenderer.invoke("rooms:vault-download-cancel", id);
}
if (process.isMainFrame && ["win32", "linux"].includes(process.platform)) contextBridge.exposeInMainWorld("roomsVault", {
  integrationStatus: () => ipcRenderer.invoke("rooms:vault-integration-status"),
  installIntegration: () => navigator.userActivation.isActive
    ? ipcRenderer.invoke("rooms:vault-integration-install") : Promise.resolve(null),
  removeIntegration: () => navigator.userActivation.isActive
    ? ipcRenderer.invoke("rooms:vault-integration-remove") : Promise.resolve(null),
  pendingArchive: () => ipcRenderer.invoke("rooms:vault-pending"),
  prepareArchive: () => ipcRenderer.invoke("rooms:vault-archive-prepare"),
  readArchive: vaultReadArchive,
  cancelArchive: id => id === undefined || id === null || vaultUuid(id)
    ? ipcRenderer.invoke("rooms:vault-archive-cancel", id) : vaultInvalid(),
  prepareDownload: vaultPrepareDownload,
  writeDownload: vaultWriteDownload,
  completeDownload: vaultCompleteDownload,
  cancelDownload: vaultCancelDownload,
  onPending(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("rooms:vault-pending", listener);
    return () => { ipcRenderer.off("rooms:vault-pending", listener); };
  },
});
if (process.isMainFrame && ["win32", "linux"].includes(process.platform)) contextBridge.exposeInMainWorld("roomsDesktopShare", {
  protectedCapture: true,
  arm: (id, language) => navigator.userActivation.isActive
    ? ipcRenderer.invoke("rooms:share-arm", id, language) : Promise.resolve(false),
  take: id => ipcRenderer.invoke("rooms:share-take", id),
  preview: (id, thumbnail, aspect, sourceWidth, sourceHeight) => ipcRenderer.invoke("rooms:share-preview", id, thumbnail, aspect, sourceWidth, sourceHeight),
  cancel: id => ipcRenderer.invoke("rooms:share-cancel", id),
});
if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsDesktopNotifications", {
  notify: input => ipcRenderer.invoke("rooms:desktop-notify", input),
});
if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsDesktopVideo", {
  authorize: () => navigator.userActivation.isActive
    ? ipcRenderer.invoke("rooms:authorize-detached-video") : Promise.resolve(null),
});

if (process.isMainFrame) {
  let visible = false;
  const observers = new Set();
  ipcRenderer.on("rooms:visibility", (_event, value) => {
    visible = value === true;
    for (const observer of observers) observer(visible);
  });
  contextBridge.exposeInMainWorld("roomsWindowVisibility", {
    observe(callback) {
      observers.add(callback);
      callback(visible);
      return () => { observers.delete(callback); };
    },
  });
}

if (process.isMainFrame && process.argv.includes("--rooms-remember-login")) {
  contextBridge.exposeInMainWorld("roomsDesktopLogin", {
    load: id => ipcRenderer.invoke("rooms:login-load", id),
    save: (id, vault) => ipcRenderer.invoke("rooms:login-save", { id, vault }),
    forget: () => ipcRenderer.invoke("rooms:login-forget"),
    discard: () => ipcRenderer.invoke("rooms:login-discard"),
  });
}

if (process.isMainFrame && process.argv.includes("--rooms-native-capture")) {
  const capture = {
    open: (channel, language, embedded) => navigator.userActivation.isActive
      ? ipcRenderer.invoke("rooms:native-capture-open", channel, language, embedded === true) : Promise.resolve("unavailable"),
    close: () => ipcRenderer.invoke("rooms:native-capture-close"),
  };
  if (process.argv.includes("--rooms-embedded-preview")) {
    capture.status = () => ipcRenderer.invoke("rooms:native-capture-status");
    capture.observe = (status, preview) => {
      const changed = (_event, value) => status(value);
      const frame = (_event, id, bytes) => preview(id, bytes);
      ipcRenderer.on("rooms:native-capture-status", changed);
      ipcRenderer.on("rooms:native-capture-preview", frame);
      return () => {
        ipcRenderer.off("rooms:native-capture-status", changed);
        ipcRenderer.off("rooms:native-capture-preview", frame);
      };
    };
  }
  contextBridge.exposeInMainWorld("roomsNativeCapture", capture);
}

if (process.isMainFrame && (process.platform === "linux" ||
    (process.platform === "win32" && process.argv.includes("--rooms-windows-audio")))) {
  const callbacks = new Map();
  ipcRenderer.on("rooms:audio-data", (_event, id, pcm) => callbacks.get(id)?.data(pcm));
  ipcRenderer.on("rooms:audio-ended", (_event, id) => {
    const active = callbacks.get(id);
    callbacks.delete(id);
    active?.end();
  });
  contextBridge.exposeInMainWorld("roomsDesktopAudio", {
    supportedModes: Object.freeze(process.platform === "linux" || process.argv.includes("--rooms-windows-application-audio")
      ? ["application", "system"] : ["system"]),
    async open(id, mode, data, end) {
      callbacks.set(id, { data, end });
      try {
        const result = await ipcRenderer.invoke("rooms:audio-open", id, mode);
        if (result === "ok") return result;
        callbacks.delete(id);
        return result;
      } catch (error) {
        callbacks.delete(id);
        throw error;
      }
    },
    close(id) {
      callbacks.delete(id);
      return ipcRenderer.invoke("rooms:audio-close", id);
    },
  });
}
