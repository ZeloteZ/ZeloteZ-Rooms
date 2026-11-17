"use strict";

const { BrowserWindow } = require("electron");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { hasRoomsPageHeaders } = require("./instance.cjs");

const popupName = "zelotez-rooms-video";
const popupPath = "/video-window.html";

function detachedVideo(opener, origin, active, allowEmbed, icon) {
  const address = origin + popupPath;
  let child;
  let permit;

  function hasChild() {
    return Boolean(child && !child.isDestroyed());
  }

  function reset() {
    permit = null;
    if (hasChild()) child.destroy();
    child = null;
  }

  function authorize() {
    if (!active()) return null;
    if (hasChild()) {
      child.focus();
      return null;
    }
    permit = { token: randomBytes(16).toString("hex"), expires: performance.now() + 4000 };
    return permit.token;
  }

  function handles({ frameName, url }) {
    if (frameName === popupName) return true;
    try {
      const target = new URL(url);
      return target.origin === origin && target.pathname === popupPath;
    } catch {
      return false;
    }
  }

  function handleOpen({ url, frameName, features, postBody }) {
    const tickets = features.split(",").map(feature => feature.trim()).filter(feature => feature.startsWith("roomsVideoTicket="));
    if (!active() || hasChild() || !permit || performance.now() >= permit.expires || url !== address ||
        frameName !== popupName || tickets.length !== 1 || tickets[0] !== "roomsVideoTicket=" + permit.token || postBody) {
      return { action: "deny" };
    }
    permit = null;
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        title: "ZeloteZ Rooms", icon, width: 430, height: 356, minWidth: 340, minHeight: 322,
        useContentSize: true, show: false,
        frame: true, resizable: true, autoHideMenuBar: true, backgroundColor: "#141419",
        webPreferences: {
          session: opener.session, preload: path.join(__dirname, "video-preload.cjs"), additionalArguments: [],
          sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
        },
      },
      createWindow(options) {
        const window = new BrowserWindow(options);
        child = window;
        const contents = window.webContents;
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-frame-navigate", event => {
          if (!active() || !(event.isMainFrame ? event.url === address : allowEmbed(event.url, event.frame))) event.preventDefault();
        });
        contents.on("will-redirect", event => {
          if (!active() || event.isMainFrame || !allowEmbed(event.url, event.frame)) event.preventDefault();
        });
        contents.on("did-fail-load", (_event, _error, _reason, _url, isMainFrame) => {
          if (isMainFrame && !window.isDestroyed()) window.destroy();
        });
        contents.on("render-process-gone", () => { if (!window.isDestroyed()) window.destroy(); });
        window.once("ready-to-show", () => {
          if (active() && !window.isDestroyed()) window.show();
        });
        window.once("closed", () => {
          if (child === window) child = null;
        });
        return contents;
      },
    };
  }

  function navigation(details, response = false) {
    if (!hasChild() || details.webContentsId !== child.webContents.id) return null;
    if (!active()) return false;
    if (details.resourceType === "subFrame") return allowEmbed(details.url, details.frame);
    return details.method === "GET" && details.url === address &&
      (!response || hasRoomsPageHeaders(details.statusCode, details.responseHeaders));
  }

  opener.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) reset();
  });
  opener.on("render-process-gone", reset);
  opener.once("destroyed", reset);
  return { authorize, handles, handleOpen, navigation, reset };
}

module.exports = { detachedVideo };
