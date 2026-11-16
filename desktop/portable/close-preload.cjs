"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsClose", {
  state: () => ipcRenderer.invoke("rooms:close-state"),
  decide: (action, suppress) => ipcRenderer.invoke("rooms:close-decision", action, suppress),
});
