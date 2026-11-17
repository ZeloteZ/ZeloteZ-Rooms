"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsLocal", {
  state: () => ipcRenderer.invoke("rooms:local-state"),
  submit: input => ipcRenderer.invoke("rooms:local-submit", input),
  preference: (name, value) => ipcRenderer.invoke("rooms:local-preference", name, value),
  check: address => ipcRenderer.invoke("rooms:local-check", address),
  connect: address => ipcRenderer.invoke("rooms:local-connect", address),
  cancel: () => ipcRenderer.invoke("rooms:local-cancel"),
  updateIntro: action => ipcRenderer.invoke("rooms:local-update-intro", action),
  updateToken: (action, token) => ipcRenderer.invoke("rooms:local-update-token", action, token),
  checkUpdate: () => ipcRenderer.invoke("rooms:local-update-check"),
  openRelease: () => ipcRenderer.invoke("rooms:local-update-open"),
  onFocusUpdates: callback => { ipcRenderer.on("rooms:local-focus-updates", () => callback()); },
});
