"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsDesktop", true);

if (process.isMainFrame && process.argv.includes("--rooms-native-capture")) {
  contextBridge.exposeInMainWorld("roomsNativeCapture", {
    open: (channel, language) => navigator.userActivation.isActive
      ? ipcRenderer.invoke("rooms:native-capture-open", channel, language) : Promise.resolve("unavailable"),
    close: () => ipcRenderer.invoke("rooms:native-capture-close"),
  });
}

if (process.isMainFrame && process.platform === "linux") {
  const callbacks = new Map();
  ipcRenderer.on("rooms:audio-data", (_event, id, pcm) => callbacks.get(id)?.data(pcm));
  ipcRenderer.on("rooms:audio-ended", (_event, id) => {
    const active = callbacks.get(id);
    callbacks.delete(id);
    active?.end();
  });
  contextBridge.exposeInMainWorld("roomsDesktopAudio", {
    async open(id, mode, data, end) {
      callbacks.set(id, { data, end });
      try {
        const result = await ipcRenderer.invoke("rooms:audio-open", id, mode);
        if (result === "ok") return result;
        callbacks.delete(id);
        return result;
      } catch (error) {
        callbacks.delete(id);
        throw error;
      }
    },
    close(id) {
      callbacks.delete(id);
      return ipcRenderer.invoke("rooms:audio-close", id);
    },
  });
}
