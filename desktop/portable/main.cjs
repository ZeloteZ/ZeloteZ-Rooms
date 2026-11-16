"use strict";

const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installAudio } = require("./audio.cjs");
const { nativeHelper, installNativeCapture } = require("./native-capture.cjs");

const localPage = path.join(__dirname, "ui", "index.html");
const localUrl = pathToFileURL(localPage).href;
const appIcon = path.join(__dirname, "ui", "icon.png");
const localWindows = new Map();
let roomsWindow;
let settingsWindow;
let connection = 0;
let currentOrigin = "";
let rememberedOrigin = "";
let german = false;
let captureProgram;
const text = (en, de) => german ? de : en;

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
  const url = webUrl(value.trim());
  if (!url || url.pathname !== "/" || url.href.slice(url.origin.length) !== "/" || url.port === "0") return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || loopback ? url.origin : null;
}

function isRoomsPage(value, origin) {
  const url = webUrl(value);
  return url?.origin === origin && url.pathname === "/";
}

function setupPath() {
  return path.join(app.getPath("userData"), "server-origin");
}

async function saveServer(origin) {
  const file = setupPath();
  const temporary = file + ".new";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, origin + "\n", { mode: 0o600 });
  await rename(temporary, file);
  rememberedOrigin = origin;
}

function localWindow(mode, state, parent) {
  const settings = mode === "settings";
  const title = mode === "audio" ? text("Choose audio", "Tonquelle auswählen") : text("Share your screen", "Bildschirm teilen");
  const window = new BrowserWindow({
    parent, modal: Boolean(parent), show: false, icon: appIcon, autoHideMenuBar: true, backgroundColor: "#15151b",
    title: settings ? "ZeloteZ Rooms" : title,
    width: settings ? 510 : 745, height: settings ? 370 : 590, minWidth: 340, minHeight: 310,
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
ipcMain.handle("rooms:local-submit", async (event, input) => {
  const local = localSender(event);
  if (!local) return false;
  if (local.state.mode !== "settings") {
    if (!Number.isInteger(input) || input < 0 || input >= local.state.sources.length) return false;
    local.selection = input;
    local.window.close();
    return true;
  }
  const origin = serverOrigin(input);
  if (!origin) return "invalid";
  try {
    await saveServer(origin);
  } catch {
    return "save";
  }
  if (local.window.isDestroyed()) return false;
  setImmediate(() => connect(origin));
  return true;
});

function showSettings(error = false) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  const local = localWindow("settings", {
    address: currentOrigin || rememberedOrigin, error, canCancel: Boolean(roomsWindow?.isVisible()),
  }, roomsWindow?.isVisible() ? roomsWindow : undefined);
  settingsWindow = local.window;
  settingsWindow.on("closed", () => { settingsWindow = null; });
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

function installPermissions(window, origin, media) {
  const web = window.webContents;
  let microphone = false;
  let microphonePrompt;
  let picking = false;
  const approveAudio = installAudio(web, value => !window.isDestroyed() && isRoomsPage(value, origin),
    (mode, sources) => choose(window, "audio", sources, { audioMode: mode, sources: sources.map(source => ({ name: source.title })) }));
  const allowed = (contents, target, main) => !window.isDestroyed() && !web.isDestroyed()
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
    const valid = () => !web.isDestroyed() && !window.isDestroyed() && request.frame?.detached === false
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

function connect(origin) {
  const previous = roomsWindow;
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
  roomsWindow = window;
  currentOrigin = origin;
  settingsWindow?.close();
  previous?.close();
  installPermissions(window, origin, media);

  const contents = window.webContents;
  installNativeCapture(contents, captureProgram, origin, media, value => isRoomsPage(value, origin));
  contents.on("will-frame-navigate", event => {
    if (!event.isMainFrame || !isRoomsPage(event.url, origin)) event.preventDefault();
  });
  contents.on("will-redirect", event => {
    if (!event.isMainFrame || !isRoomsPage(event.url, origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const external = webUrl(url);
    if (external && isRoomsPage(contents.getURL(), origin)) shell.openExternal(external.href).catch(() => {});
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (roomsWindow === window) roomsWindow = null;
  });
  window.loadURL(origin + "/").then(() => {
    if (!window.isDestroyed()) window.show();
  }).catch(() => {
    if (window === roomsWindow) showSettings(true);
    if (!window.isDestroyed()) window.destroy();
  });
}

function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "ZeloteZ Rooms", submenu: [
      { label: text("Server settings…", "Servereinstellungen …"), accelerator: "CmdOrCtrl+,", click: () => showSettings() },
      { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: text("View", "Ansicht"), submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("window-all-closed", () => app.quit());
  app.on("second-instance", () => (settingsWindow ?? roomsWindow)?.focus());
  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark";
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    german = app.getLocale().toLowerCase().startsWith("de");
    menus();
    captureProgram = await nativeHelper();
    try { rememberedOrigin = serverOrigin(await readFile(setupPath(), "utf8")) ?? ""; } catch { /* First launch. */ }
    const origin = process.env.ZELOTEZ_ROOMS_ORIGIN ? serverOrigin(process.env.ZELOTEZ_ROOMS_ORIGIN) : rememberedOrigin;
    if (origin) connect(origin);
    else showSettings();
  });
}
