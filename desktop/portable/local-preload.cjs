"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsLocal", {
  state: () => ipcRenderer.invoke("rooms:local-state"),
  submit: input => ipcRenderer.invoke("rooms:local-submit", input),
  cancel: () => ipcRenderer.invoke("rooms:local-cancel"),
});
