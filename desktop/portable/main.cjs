"use strict";

const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require("electron");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installAudio } = require("./audio.cjs");
const { desktopNotifications } = require("./desktop-notifications.cjs");
const { hasRoomsPageHeaders, verifyInstance } = require("./instance.cjs");
const { nativeHelper, installNativeCapture } = require("./native-capture.cjs");
const { trayHostAvailable, trayUsable } = require("./tray.cjs");

const localPage = path.join(__dirname, "ui", "index.html");
const localUrl = pathToFileURL(localPage).href;
const appIcon = path.join(__dirname, "ui", "icon.png");
const localWindows = new Map();
const notifications = desktopNotifications(appIcon);
let roomsWindow;
let roomsDocumentIsActive;
let settingsWindow;
let tray;
let trayInitializing;
let connection = 0;
let connecting = false;
let backgrounding = false;
let quitting = false;
let currentOrigin = "";
let desktopSettings = { language: "system", appearance: "dark", notifications: true, keepRunning: true, suppressCloseHint: false, origin: "" };
let settingsWrites = Promise.resolve();
let german = false;
let captureProgram;
const text = (en, de) => german ? de : en;
const preferenceOptions = { language: ["system", "en", "de"], appearance: ["dark", "system", "light"],
  notifications: [true, false], keepRunning: [true, false] };
const verificationErrors = new Set(["invalid", "unreachable", "not_rooms", "incompatible"]);

function webUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function serverOrigin(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\%]/u.test(value.trim())) return null;
  const address = value.trim();
  if (!/^https?:\/\/[^/?#]+\/?$/iu.test(address)) return null;
  const url = webUrl(address);
  if (!url || url.pathname !== "/" || url.href.slice(url.origin.length) !== "/" || url.port === "0") return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || loopback ? url.origin : null;
}

function isRoomsPage(value, origin) {
  const url = webUrl(value);
  return url?.origin === origin && url.pathname === "/";
}

function settingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

async function loadSettings() {
  try {
    const saved = JSON.parse(await readFile(settingsPath(), "utf8"));
    for (const [name, values] of Object.entries(preferenceOptions)) {
      if (values.includes(saved?.[name])) desktopSettings[name] = saved[name];
    }
    desktopSettings.suppressCloseHint = saved?.suppressCloseHint === true;
    desktopSettings.origin = serverOrigin(saved?.origin) ?? "";
  } catch (error) {
    if (process.platform === "linux" && error.code === "ENOENT") return readLegacyLinuxSettings();
  }
  return null;
}

async function readLegacyLinuxSettings() {
  const folder = path.join(app.getPath("appData"), "zelotez-rooms");
  const read = name => readFile(path.join(folder, name), "utf8").then(value => value.trim(), () => "");
  const [address, language, appearance, notifications, keepRunning, suppressCloseHint] = await Promise.all([
    read("server"), read("desktop-language"), read("appearance"), read("desktop-notifications"),
    read("minimize-on-close"), read("skip-minimize-confirmation"),
  ]);
  if (preferenceOptions.language.includes(language)) desktopSettings.language = language;
  if (preferenceOptions.appearance.includes(appearance)) desktopSettings.appearance = appearance;
  if (notifications === "false") desktopSettings.notifications = false;
  if (keepRunning === "false") desktopSettings.keepRunning = false;
  desktopSettings.suppressCloseHint = suppressCloseHint === "true";
  try {
    const saved = JSON.parse(address);
    return saved?.protocol === 1 ? serverOrigin(saved.origin) : null;
  } catch {
    return serverOrigin(address);
  }
}

function saveSettings(changes) {
  const writing = settingsWrites.then(async () => {
    const settings = { ...desktopSettings, ...changes };
    const file = settingsPath();
    const temporary = file + ".new";
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(settings) + "\n", { mode: 0o600 });
    await rename(temporary, file);
    desktopSettings = settings;
  });
  settingsWrites = writing.catch(() => {});
  return writing;
}

function applyPreferences() {
  german = desktopSettings.language === "system" ? app.getLocale().toLowerCase().startsWith("de") : desktopSettings.language === "de";
  nativeTheme.themeSource = desktopSettings.appearance;
  menus();
  updateTray();
  if (!desktopSettings.notifications) notifications.clear();
}

function localWindow(mode, state, parent) {
  const settings = mode === "settings";
  const title = mode === "audio" ? text("Choose audio", "Tonquelle auswählen")
    : mode === "picker" ? text("Share your screen", "Bildschirm teilen") : "ZeloteZ Rooms";
  const window = new BrowserWindow({
    parent, modal: Boolean(parent) && !settings, show: false, icon: appIcon, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#15151b" : "#f6f5fb",
    title,
    width: settings ? 570 : mode === "tray-hint" ? 450 : 745,
    height: settings ? (state.currentOrigin ? 560 : 395) : mode === "tray-hint" ? 365 : 590,
    minWidth: 340, minHeight: 310,
    webPreferences: {
      preload: path.join(__dirname, "local-preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false,
    },
  });
  const contents = window.webContents;
  const id = contents.id;
  const local = { window, contents, state: { mode, language: german ? "de" : "en", ...state } };
  localWindows.set(id, local);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", event => event.preventDefault());
  window.on("closed", () => localWindows.delete(id));
  window.once("ready-to-show", () => window.show());
  window.loadFile(localPage).catch(() => {
    if (!window.isDestroyed()) window.destroy();
  });
  return local;
}

function localSender(event) {
  const local = localWindows.get(event.sender.id);
  if (local?.contents === event.sender && event.senderFrame === event.sender.mainFrame
      && event.senderFrame.url === localUrl) return local;
  return null;
}

ipcMain.handle("rooms:local-state", event => localSender(event)?.state ?? null);
ipcMain.handle("rooms:local-cancel", event => localSender(event)?.window.close());
ipcMain.handle("rooms:local-submit", (event, input) => {
  const local = localSender(event);
  if (!local?.state.sources || !Number.isInteger(input) || input < 0 || input >= local.state.sources.length) return false;
  local.selection = input;
  local.window.close();
  return true;
});

ipcMain.handle("rooms:local-close-action", (event, action, suppress) => {
  const local = localSender(event);
  if (local?.state.mode !== "tray-hint" || (action !== "minimize" && action !== "quit") || typeof suppress !== "boolean") return false;
  local.closeChoice = { action, suppress };
  local.window.close();
  return true;
});

function settingsSender(event) {
  const local = localSender(event);
  return local?.state.mode === "settings" && local.window === settingsWindow ? local : null;
}

ipcMain.handle("rooms:local-preference", async (event, name, value) => {
  const local = settingsSender(event);
  if (!local || typeof name !== "string" || !Object.hasOwn(preferenceOptions, name) || !preferenceOptions[name].includes(value)) return false;
  try {
    await saveSettings({ [name]: value });
  } catch {
    return false;
  }
  applyPreferences();
  local.state.preferences[name] = value;
  local.state.language = german ? "de" : "en";
  return { language: local.state.language };
});

ipcMain.handle("rooms:local-check", async (event, input) => {
  const local = settingsSender(event);
  if (!local || local.operation) return { error: "unavailable" };
  const origin = serverOrigin(input);
  local.checked = null;
  if (!origin) return { error: "invalid" };
  if (origin === currentOrigin) return { error: "current" };
  const operation = new AbortController();
  local.operation = operation;
  try {
    await verifyInstance(origin, { signal: operation.signal });
    if (operation.signal.aborted) return { error: "unavailable" };
    local.checked = { origin, expiresAt: Date.now() + 5 * 60 * 1000 };
    return { origin };
  } catch (error) {
    return { error: verificationErrors.has(error?.code) ? error.code : "unavailable" };
  } finally {
    local.operation = null;
  }
});

ipcMain.handle("rooms:local-connect", async (event, input) => {
  const local = settingsSender(event);
  if (!local || local.operation || connecting) return { error: "unavailable" };
  const origin = serverOrigin(input);
  if (!origin) return { error: "invalid" };
  if (origin === currentOrigin) return { error: "current" };
  if (local.checked?.origin !== origin || local.checked.expiresAt < Date.now()) return { error: "changed" };
  local.checked = null;
  const operation = new AbortController();
  local.operation = operation;
  try {
    return await connect(origin, { signal: operation.signal, local });
  } finally {
    local.operation = null;
  }
});

function showSettings(error = false, suggested = "") {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  if (connecting) return;
  const parent = roomsWindow?.isVisible() ? roomsWindow : undefined;
  const local = localWindow("settings", {
    address: currentOrigin || suggested,
    currentOrigin,
    error,
    preferences: Object.fromEntries(Object.keys(preferenceOptions).map(name => [name, desktopSettings[name]])),
  }, parent);
  settingsWindow = local.window;
  settingsWindow.on("close", event => {
    if (local.savingConnection) event.preventDefault();
  });
  settingsWindow.on("closed", () => {
    local.operation?.abort();
    settingsWindow = null;
  });
}

function chooseSource(parent, sources) {
  if (!sources.length || parent.isDestroyed()) return Promise.resolve(null);
  return choose(parent, "picker", sources, { sources: sources.map(source => ({
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
  })) }).result;
}

function choose(parent, mode, entries, state) {
  const local = localWindow(mode, state, parent);
  const result = new Promise(resolve => {
    local.window.once("closed", () => resolve(entries[local.selection] ?? null));
  });
  return { window: local.window, result };
}

function restoreWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function wantsTray() {
  return desktopSettings.keepRunning && roomsWindow && !quitting;
}

function updateTray() {
  if (!wantsTray()) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray) {
    configureTray();
    return;
  }
  trayInitializing ??= trayHostAvailable().then(supported => {
    if (supported && wantsTray()) configureTray();
  }).finally(() => { trayInitializing = null; });
}

function configureTray() {
  try {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(appIcon).resize({ width: 22, height: 22 }));
      tray.setToolTip("ZeloteZ Rooms");
      tray.on("click", () => restoreWindow(roomsWindow));
      tray.on("double-click", () => restoreWindow(roomsWindow));
    }
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: text("Open ZeloteZ Rooms", "ZeloteZ Rooms öffnen"), click: () => restoreWindow(roomsWindow) },
      { label: text("Desktop settings…", "Desktop-Einstellungen …"), click: () => { restoreWindow(roomsWindow); showSettings(); } },
      { type: "separator" },
      { label: text("Quit ZeloteZ Rooms", "ZeloteZ Rooms beenden"), click: () => app.quit() },
    ]));
  } catch {
    tray?.destroy();
    tray = null;
  }
}

function confirmClose(window, hasTray) {
  const local = localWindow("tray-hint", { hasTray }, window);
  return new Promise(resolve => {
    local.window.once("closed", () => resolve(local.closeChoice));
  });
}

async function moveToBackground(window) {
  if (backgrounding) return;
  backgrounding = true;
  try {
    if (!tray) updateTray();
    await trayInitializing?.catch(() => {});
    const hasTray = await trayUsable(tray).catch(() => false);
    if (quitting || window !== roomsWindow || !desktopSettings.keepRunning) return;
    if (!desktopSettings.suppressCloseHint) {
      const choice = await confirmClose(window, hasTray);
      if (!choice || quitting || window !== roomsWindow) return;
      if (choice.suppress) await saveSettings({ suppressCloseHint: true }).catch(() => {});
      if (choice.action === "quit") {
        app.quit();
        return;
      }
    }
    const canHide = hasTray && await trayUsable(tray).catch(() => false);
    if (quitting || window !== roomsWindow || !desktopSettings.keepRunning) return;
    if (canHide) {
      settingsWindow?.close();
      window.hide();
    } else window.minimize();
  } finally {
    backgrounding = false;
  }
}

function isRoomsSender(event) {
  return roomsDocumentIsActive?.() && event.sender === roomsWindow.webContents &&
    event.senderFrame && !event.senderFrame.detached && event.senderFrame === event.sender.mainFrame &&
    isRoomsPage(event.senderFrame.url, currentOrigin);
}

ipcMain.handle("rooms:desktop-notify", (event, input) => {
  if (!desktopSettings.notifications || !isRoomsSender(event)) return false;
  const window = roomsWindow;
  return notifications.show(input, href => {
    if (window !== roomsWindow || !roomsDocumentIsActive?.() || !isRoomsPage(window.webContents.getURL(), currentOrigin)) return;
    restoreWindow(window);
    window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(href)}`).catch(() => {});
  });
});

function installPermissions(window, origin, media, isActive) {
  const web = window.webContents;
  let microphone = false;
  let microphonePrompt;
  let picking = false;
  const approveAudio = installAudio(web, value => isActive() && isRoomsPage(value, origin),
    (mode, sources) => choose(window, "audio", sources, { audioMode: mode, sources: sources.map(source => ({ name: source.title })) }));
  const allowed = (contents, target, main) => isActive()
    && contents === web && main === true && isRoomsPage(web.getURL(), origin) && webUrl(target)?.origin === origin;

  media.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!allowed(contents, requestingOrigin, details.isMainFrame)) return false;
    return ["display-capture", "fullscreen", "clipboard-sanitized-write"].includes(permission)
      || (permission === "media" && microphone && details.mediaType === "audio");
  });
  media.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestAllowed = () => allowed(contents, details.requestingUrl, details.isMainFrame);
    if (!requestAllowed()) return callback(false);
    if (["display-capture", "fullscreen", "clipboard-sanitized-write"].includes(permission)) return callback(true);
    if (permission !== "media" || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== "audio") {
      return callback(false);
    }
    microphonePrompt ??= microphone ? Promise.resolve(true) : dialog.showMessageBox(window, {
      type: "question",
      message: text("Allow microphone access?", "Mikrofonzugriff erlauben?"),
      detail: text("ZeloteZ Rooms uses the microphone for voice chat.", "ZeloteZ Rooms nutzt das Mikrofon für den Sprachchat."),
      buttons: [text("Cancel", "Abbrechen"), text("Allow", "Erlauben")], defaultId: 0, cancelId: 0,
    }).then(result => result.response === 1);
    microphonePrompt.then(result => {
      microphone = result && requestAllowed();
      callback(microphone);
    }, () => callback(false)).finally(() => { microphonePrompt = null; });
  });

  media.setDisplayMediaRequestHandler(async (request, callback) => {
    const valid = () => isActive() && request.frame?.detached === false
      && request.frame === web.mainFrame && webUrl(request.securityOrigin)?.origin === origin && isRoomsPage(request.frame.url, origin);
    if (picking || !request.videoRequested || !request.userGesture || !valid()) return callback(null);
    picking = true;
    let capture = null;
    try {
      const wayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY);
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        // PipeWire's chooser already shows previews. Some Wayland backends only
        // start delivering frames once the approved source is actually opened.
        thumbnailSize: wayland ? { width: 0, height: 0 } : { width: 288, height: 162 },
      });
      if (valid()) {
        const [source] = sources;
        // Chromium marks sources approved in a native picker with ":s".
        const portalSource = wayland && sources.length === 1 && /^(?:window|screen):\d+:\d+:s$/u.test(source?.id);
        capture = portalSource ? source : await chooseSource(window, sources);
      }
    } catch {
      // A canceled or unavailable system picker ends this capture request.
    } finally {
      picking = false;
    }
    try {
      if (!capture || !valid()) callback(null);
      else {
        approveAudio();
        callback({ video: capture });
      }
    } catch {
      // Chromium discards the pending request when its frame closes.
    }
  });
}

function prepareRoomsWindow(origin) {
  const media = session.fromPartition("rooms:" + ++connection);
  const window = new BrowserWindow({
    title: "ZeloteZ Rooms", width: 1240, height: 790, minWidth: 360, minHeight: 360, show: false,
    icon: appIcon, backgroundColor: "#15151b", autoHideMenuBar: true,
    webPreferences: {
      session: media, preload: path.join(__dirname, "rooms-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false,
      additionalArguments: captureProgram ? ["--rooms-native-capture",
        ...(captureProgram.embedded ? ["--rooms-embedded-preview"] : [])] : [],
    },
  });
  const contents = window.webContents;
  let documentVerified = false;
  let closing = false;
  const isActive = () => roomsWindow === window && documentVerified && !window.isDestroyed() && !contents.isDestroyed();
  const navigation = { urls: ["<all_urls>"], types: ["mainFrame", "subFrame"] };
  const allowed = details => details.resourceType === "mainFrame" && details.webContentsId === contents.id
    && details.method === "GET" && isRoomsPage(details.url, origin);
  media.webRequest.onBeforeRequest(navigation, (details, callback) => {
    const accept = allowed(details);
    if (accept) documentVerified = false;
    callback({ cancel: !accept });
  });
  media.webRequest.onHeadersReceived(navigation, (details, callback) => {
    const accept = allowed(details) && hasRoomsPageHeaders(details.statusCode, details.responseHeaders);
    if (allowed(details)) documentVerified = accept;
    callback({ cancel: !accept });
  });
  installPermissions(window, origin, media, isActive);
  installNativeCapture(contents, captureProgram, origin, media, value => isActive() && isRoomsPage(value, origin));
  contents.on("will-frame-navigate", event => {
    if (!event.isMainFrame || !isRoomsPage(event.url, origin)) event.preventDefault();
  });
  contents.on("will-redirect", event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const external = webUrl(url);
    if (external && isActive() && isRoomsPage(contents.getURL(), origin)) shell.openExternal(external.href).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-prevent-unload", event => {
    if (quitting || closing) event.preventDefault();
  });
  window.on("close", event => {
    if (window !== roomsWindow || quitting || !desktopSettings.keepRunning) {
      closing = true;
      return;
    }
    event.preventDefault();
    moveToBackground(window).catch(() => {});
  });
  window.on("closed", () => {
    if (roomsWindow === window) {
      roomsWindow = null;
      roomsDocumentIsActive = null;
      currentOrigin = "";
      notifications.clear();
      updateTray();
    }
  });
  return { window, isActive, verified: () => documentVerified && !window.isDestroyed() && isRoomsPage(contents.getURL(), origin) };
}

async function connect(origin, { signal, local } = {}) {
  if (connecting) return { error: "unavailable" };
  connecting = true;
  let prepared;
  try {
    await verifyInstance(origin, { signal });
    signal?.throwIfAborted();
    prepared = prepareRoomsWindow(origin);
    const { window } = prepared;
    const timeout = AbortSignal.timeout(15000);
    const loading = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const abort = () => { if (!window.isDestroyed()) window.destroy(); };
    loading.addEventListener("abort", abort, { once: true });
    try {
      await window.loadURL(origin + "/");
      loading.throwIfAborted();
      if (!prepared.verified()) return { error: "load" };
    } finally {
      loading.removeEventListener("abort", abort);
    }
    if (local) {
      local.savingConnection = true;
      try {
        await saveSettings({ origin });
      } catch {
        return { error: "save" };
      } finally {
        local.savingConnection = false;
      }
    }
    const previous = roomsWindow;
    if (!prepared.verified()) return { error: "load" };
    notifications.clear();
    roomsWindow = window;
    roomsDocumentIsActive = prepared.isActive;
    currentOrigin = origin;
    local?.window.close();
    window.show();
    updateTray();
    previous?.close();
    return true;
  } catch (error) {
    return { error: verificationErrors.has(error?.code) ? error.code : prepared ? "load" : "unavailable" };
  } finally {
    if (prepared && prepared.window !== roomsWindow && !prepared.window.isDestroyed()) prepared.window.destroy();
    connecting = false;
    if (local && !roomsWindow && !settingsWindow && !quitting) app.quit();
  }
}

function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "ZeloteZ Rooms", submenu: [
      { label: text("Desktop settings…", "Desktop-Einstellungen …"), accelerator: "CmdOrCtrl+,", click: () => showSettings() },
      { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: text("View", "Ansicht"), submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("window-all-closed", () => { if (!connecting) app.quit(); });
  app.on("before-quit", () => { quitting = true; notifications.clear(); updateTray(); });
  app.on("second-instance", () => restoreWindow(settingsWindow ?? roomsWindow));
  app.on("activate", () => restoreWindow(settingsWindow ?? roomsWindow));
  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("de.zelotez.rooms");
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const legacyLinuxAddress = await loadSettings();
    applyPreferences();
    captureProgram = await nativeHelper();
    const supplied = process.env.ZELOTEZ_ROOMS_ORIGIN;
    const origin = supplied === undefined ? desktopSettings.origin : serverOrigin(supplied);
    if (origin) {
      const result = await connect(origin);
      if (result !== true) showSettings(result.error, origin);
      return;
    }
    let legacy;
    try { legacy = serverOrigin(await readFile(path.join(app.getPath("userData"), "server-origin"), "utf8")); } catch { /* First launch. */ }
    showSettings(supplied === undefined ? false : "invalid", legacy ?? legacyLinuxAddress ?? "");
  });
}
