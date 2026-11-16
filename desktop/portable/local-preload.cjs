"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsLocal", {
  state: () => ipcRenderer.invoke("rooms:local-state"),
  submit: input => ipcRenderer.invoke("rooms:local-submit", input),
  preference: (name, value) => ipcRenderer.invoke("rooms:local-preference", name, value),
  check: address => ipcRenderer.invoke("rooms:local-check", address),
  connect: address => ipcRenderer.invoke("rooms:local-connect", address),
  closeAction: (action, suppress) => ipcRenderer.invoke("rooms:local-close-action", action, suppress),
  cancel: () => ipcRenderer.invoke("rooms:local-cancel"),
});
