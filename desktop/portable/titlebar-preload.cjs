"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("roomsTitlebar", Object.freeze({
    openSettings: () => ipcRenderer.invoke("rooms:titlebar-settings"),
    onLanguage: callback => {
      ipcRenderer.on("rooms:titlebar-language", (_event, language) => callback(language));
    },
  }));
}
