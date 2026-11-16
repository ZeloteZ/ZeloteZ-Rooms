"use strict";

const { app, BrowserWindow, Menu, Tray, WebContentsView, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, session, shell } = require("electron");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installAudio } = require("./audio.cjs");
const { desktopNotifications } = require("./desktop-notifications.cjs");
const { hasRoomsPageHeaders, verifyInstance } = require("./instance.cjs");
const { nativeHelper, installNativeCapture } = require("./native-capture.cjs");
const { createRememberedLogin } = require("./remembered-login.cjs");
const { trayHostAvailable, trayUsable } = require("./tray.cjs");

const localPage = path.join(__dirname, "ui", "index.html");
const localUrl = pathToFileURL(localPage).href;
const titlebarPage = path.join(__dirname, "ui", "titlebar.html");
const titlebarUrl = pathToFileURL(titlebarPage).href;
const titlebarHeight = 40;
const closePage = path.join(__dirname, "ui", "close.html");
const closeUrl = pathToFileURL(closePage).href;
const appIcon = path.join(__dirname, "ui", "icon.png");
const localWindows = new Map();
const roomLogins = new WeakMap();
const notifications = desktopNotifications(appIcon);
let roomsWindow;
let roomsContents;
let roomsDocumentIsActive;
let settingsWindow;
let closeConfirmation;
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

function isYoutubeEmbed(url, origin) {
  return url?.origin === "https://www.youtube-nocookie.com" && /^\/embed\/[A-Za-z0-9_-]{11}$/u.test(url.pathname)
    && url.searchParams.get("origin") === origin && url.searchParams.get("enablejsapi") === "1";
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
  if (roomsWindow) updateTitlebar(roomsWindow);
  menus();
  updateTray();
  if (!desktopSettings.notifications) notifications.clear();
}

function titlebarOverlay() {
  return {
    height: titlebarHeight,
    color: nativeTheme.shouldUseDarkColors ? "#0b0b0e" : "#f4f4f8",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#efeff4" : "#27272f",
  };
}

function updateTitlebar(window) {
  if (window.isDestroyed()) return;
  if (process.platform !== "darwin") window.setTitleBarOverlay(titlebarOverlay());
  window.webContents.send("rooms:titlebar-language", german ? "de" : "en");
}

ipcMain.handle("rooms:titlebar-settings", event => {
  const frame = event.senderFrame;
  if (!roomsWindow || roomsWindow.isDestroyed() || event.sender !== roomsWindow.webContents
      || !frame || frame.detached || frame !== event.sender.mainFrame || frame.url !== titlebarUrl) return;
  showSettings();
});

function localWindow(mode, state, parent) {
  const settings = mode === "settings";
  const titles = {
    audio: text("Choose audio", "Tonquelle auswählen"),
    picker: text("Share your screen", "Bildschirm teilen"),
    settings: state.currentOrigin ? text("Desktop settings", "Desktop-Einstellungen") : "ZeloteZ Rooms",
  };
  const window = new BrowserWindow({
    parent, modal: Boolean(parent) && !settings, show: false, icon: appIcon, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0e" : "#f4f6fb",
    title: titles[mode],
    useContentSize: settings,
    width: settings ? 610 : 745,
    height: settings ? (state.currentOrigin ? 625 : 436) : 590,
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

function closeSender(event) {
  const confirmation = closeConfirmation;
  const frame = event.senderFrame;
  return confirmation?.contents === event.sender && frame && !frame.detached
    && frame === event.sender.mainFrame && frame.url === closeUrl ? confirmation : null;
}

ipcMain.handle("rooms:close-state", event => closeSender(event)?.state ?? null);
ipcMain.handle("rooms:close-decision", (event, action, suppress) => {
  const confirmation = closeSender(event);
  if (!confirmation || !["dismiss", "minimize", "quit"].includes(action) || typeof suppress !== "boolean") return false;
  if (action !== "dismiss") confirmation.choice = { action, suppress };
  confirmation.window.close();
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
  if (window === roomsWindow && !roomsContents?.isDestroyed()) roomsContents?.send("rooms:visibility", true);
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
  const hint = new BrowserWindow({
    parent: window, modal: true, show: false, frame: false, useContentSize: true, skipTaskbar: true,
    width: 460, height: 335, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    icon: appIcon, title: text("Minimize ZeloteZ Rooms", "ZeloteZ Rooms minimieren"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141419" : "#fff",
    webPreferences: {
      preload: path.join(__dirname, "close-preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false,
    },
  });
  const contents = hint.webContents;
  const confirmation = closeConfirmation = { window: hint, contents, state: { hasTray, language: german ? "de" : "en" } };
  const result = new Promise(resolve => {
    hint.once("closed", () => {
      if (closeConfirmation === confirmation) closeConfirmation = null;
      resolve(confirmation.choice ?? null);
    });
  });
  const dismiss = () => { if (!hint.isDestroyed()) hint.destroy(); };
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", event => event.preventDefault());
  contents.on("will-redirect", event => event.preventDefault());
  contents.once("render-process-gone", dismiss);
  hint.once("ready-to-show", () => hint.show());
  hint.loadFile(closePage).catch(dismiss);
  return result;
}

async function moveToBackground(window) {
  if (backgrounding) {
    const hint = closeConfirmation?.window;
    if (hint && !hint.isDestroyed()) hint.focus();
    return;
  }
  backgrounding = true;
  try {
    if (!tray) updateTray();
    await trayInitializing?.catch(() => {});
    const hasTray = await trayUsable(tray).catch(() => false);
    if (quitting || window !== roomsWindow || !desktopSettings.keepRunning) return;
    let suppress = false;
    if (!desktopSettings.suppressCloseHint) {
      const choice = await confirmClose(window, hasTray);
      if (quitting || window !== roomsWindow) return;
      if (!choice) {
        if (window.isVisible() && !window.isMinimized()) window.focus();
        return;
      }
      if (choice.action === "quit") {
        app.quit();
        return;
      }
      suppress = choice.suppress;
    }
    const canHide = hasTray && await trayUsable(tray).catch(() => false);
    if (quitting || window !== roomsWindow || !desktopSettings.keepRunning) return;
    if (canHide) {
      settingsWindow?.close();
      window.hide();
    } else window.minimize();
    if (window === roomsWindow && !roomsContents?.isDestroyed()) roomsContents?.send("rooms:visibility", false);
    if (suppress) await saveSettings({ suppressCloseHint: true }).catch(() => {});
  } finally {
    backgrounding = false;
  }
}

function isRoomsSender(event) {
  return roomsDocumentIsActive?.() && event.sender === roomsContents &&
    event.senderFrame && !event.senderFrame.detached && event.senderFrame === event.sender.mainFrame &&
    isRoomsPage(event.senderFrame.url, currentOrigin);
}

function roomLoginSender(event) {
  const entry = roomLogins.get(event.sender);
  const frame = event.senderFrame;
  return entry?.verified() && frame && !frame.detached && frame === event.sender.mainFrame &&
    isRoomsPage(frame.url, entry.origin) ? entry.login : null;
}

ipcMain.handle("rooms:login-load", (event, id) => roomLoginSender(event)?.load(id, () => Boolean(roomLoginSender(event))));
ipcMain.handle("rooms:login-discard", event => roomLoginSender(event)?.discard());
ipcMain.handle("rooms:login-save", (event, input) => isRoomsSender(event) && roomLoginSender(event)?.save(input, () => isRoomsSender(event)));
ipcMain.handle("rooms:login-forget", event => isRoomsSender(event) && roomLoginSender(event)?.forget());

ipcMain.handle("rooms:desktop-notify", (event, input) => {
  if (!desktopSettings.notifications || !isRoomsSender(event)) return false;
  const window = roomsWindow;
  const contents = event.sender;
  return notifications.show(input, href => {
    if (window !== roomsWindow || !roomsDocumentIsActive?.() || !isRoomsPage(contents.getURL(), currentOrigin)) return;
    restoreWindow(window);
    contents.executeJavaScript(`location.hash = ${JSON.stringify(href)}`).catch(() => {});
  });
});

function installPermissions(window, web, origin, media, isActive) {
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
  const login = createRememberedLogin(path.join(app.getPath("userData"), "remembered-logins"), safeStorage, process.platform, origin, media.cookies);
  const window = new BrowserWindow({
    title: "ZeloteZ Rooms", width: 1240, height: 790, minWidth: 360, minHeight: 360, show: false,
    icon: appIcon, backgroundColor: "#141419", autoHideMenuBar: true, titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? true : titlebarOverlay(),
    webPreferences: {
      preload: path.join(__dirname, "titlebar-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
    },
  });
  const chrome = window.webContents;
  chrome.setWindowOpenHandler(() => ({ action: "deny" }));
  chrome.on("will-frame-navigate", event => event.preventDefault());
  chrome.on("will-redirect", event => event.preventDefault());
  chrome.on("did-finish-load", () => updateTitlebar(window));

  const view = new WebContentsView({
    webPreferences: {
      session: media, preload: path.join(__dirname, "rooms-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false,
      additionalArguments: [...(login ? ["--rooms-remember-login"] : []), ...(captureProgram ? ["--rooms-native-capture",
        ...(captureProgram.embedded ? ["--rooms-embedded-preview"] : [])] : [])],
    },
  });
  window.contentView.addChildView(view);
  view.setBackgroundColor("#141419");
  const contents = view.webContents;
  const windowVisibility = visible => { if (!contents.isDestroyed()) contents.send("rooms:visibility", visible); };
  window.on("show", () => windowVisibility(true));
  window.on("restore", () => windowVisibility(true));
  window.on("hide", () => windowVisibility(false));
  window.on("minimize", () => windowVisibility(false));
  contents.on("did-finish-load", () => windowVisibility(window.isVisible() && !window.isMinimized()));
  let htmlFullScreen = false;
  const layout = () => {
    const [width, height] = window.getContentSize();
    const y = htmlFullScreen || window.isFullScreen() ? 0 : titlebarHeight;
    view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
  };
  layout();
  window.on("resize", layout);
  window.on("enter-full-screen", layout);
  window.on("leave-full-screen", layout);
  contents.on("enter-html-full-screen", () => { htmlFullScreen = true; layout(); });
  contents.on("leave-html-full-screen", () => { htmlFullScreen = false; layout(); });
  let documentVerified = false;
  let closing = false;
  const verified = () => documentVerified && !window.isDestroyed() && !contents.isDestroyed() && isRoomsPage(contents.getURL(), origin);
  if (login) roomLogins.set(contents, { origin, login, verified });
  const isActive = () => roomsWindow === window && documentVerified && !window.isDestroyed() && !contents.isDestroyed();
  const navigation = { urls: ["<all_urls>"], types: ["mainFrame", "subFrame"] };
  const allowedMain = details => details.method === "GET" && isRoomsPage(details.url, origin);
  function allowedChild(value, frame) {
    const url = webUrl(value);
    if (!documentVerified || url?.protocol !== "https:" || url.origin === origin) return false;
    if (isYoutubeEmbed(url, origin)) return true;
    // Child frames used by YouTube stay below its sandboxed, cross-origin player.
    for (let parent = frame?.parent; parent && !parent.detached; parent = parent.parent) {
      if (isYoutubeEmbed(webUrl(parent.url), origin)) return true;
    }
    return false;
  }
  media.webRequest.onBeforeRequest(navigation, (details, callback) => {
    if (details.webContentsId !== contents.id) return callback({ cancel: true });
    const main = details.resourceType === "mainFrame";
    const accept = main ? allowedMain(details) : allowedChild(details.url, details.frame);
    if (accept && main) documentVerified = false;
    callback({ cancel: !accept });
  });
  media.webRequest.onHeadersReceived(navigation, (details, callback) => {
    if (details.webContentsId !== contents.id) return callback({ cancel: true });
    if (details.resourceType === "subFrame") return callback({ cancel: !allowedChild(details.url, details.frame) });
    const acceptedAddress = allowedMain(details);
    const accept = acceptedAddress && hasRoomsPageHeaders(details.statusCode, details.responseHeaders);
    if (acceptedAddress) documentVerified = accept;
    callback({ cancel: !accept });
  });
  installPermissions(window, contents, origin, media, isActive);
  installNativeCapture(contents, captureProgram, origin, media, value => isActive() && isRoomsPage(value, origin));
  contents.on("will-frame-navigate", event => {
    const allow = event.isMainFrame ? isRoomsPage(event.url, origin) : allowedChild(event.url, event.frame);
    if (!allow) event.preventDefault();
  });
  contents.on("will-redirect", event => {
    if (event.isMainFrame || !allowedChild(event.url, event.frame)) event.preventDefault();
  });
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
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: closing });
    if (roomsWindow === window) {
      roomsWindow = null;
      roomsContents = null;
      roomsDocumentIsActive = null;
      currentOrigin = "";
      notifications.clear();
      updateTray();
    }
  });
  return { window, contents, login, isActive, verified };
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
      await prepared.login?.restore();
      loading.throwIfAborted();
      await Promise.all([window.loadFile(titlebarPage), prepared.contents.loadURL(origin + "/")]);
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
    roomsContents = prepared.contents;
    roomsDocumentIsActive = prepared.isActive;
    currentOrigin = origin;
    local?.window.close();
    window.show();
    roomsContents.focus();
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
    nativeTheme.on("updated", () => { if (roomsWindow) updateTitlebar(roomsWindow); });
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
