"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsCaptureOwner", Object.freeze({
  onCommand: callback => ipcRenderer.on("rooms:capture-owner-command", (_event, id, operation, value) => callback(id, operation, value)),
  reply: (id, value, error) => ipcRenderer.send("rooms:capture-owner-reply", id, value, error),
  ended: reason => ipcRenderer.send("rooms:capture-owner-ended", reason),
}));
