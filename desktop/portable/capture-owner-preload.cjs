"use strict";

const { contextBridge, ipcRenderer, sharedTexture } = require("electron");

if (process.isMainFrame) {
  const ended = reason => ipcRenderer.send("rooms:capture-owner-ended", reason);
  contextBridge.exposeInMainWorld("roomsCaptureOwner", Object.freeze({
    onCommand: callback => ipcRenderer.on("rooms:capture-owner-command", (_event, id, operation, value) => callback(id, operation, value)),
    reply: (id, value, error) => ipcRenderer.send("rooms:capture-owner-reply", id, value, error),
    ended,
  }));

  // VideoFrame is transferable through a DOM MessagePort. The context bridge
  // cannot pass it directly, and the local texture API never reaches the site.
  function connectNativeFrames(event) {
    if (event.source !== window || event.data !== "rooms:capture-owner-native-port" || event.ports.length !== 1) return;
    window.removeEventListener("message", connectNativeFrames);
    const [port] = event.ports;
    let active = true;
    let inFlight = false;
    let newest = -1;
    port.onmessage = ({ data }) => { if (data === "received") inFlight = false; };
    window.addEventListener("pagehide", () => { active = false; port.close(); }, { once: true });
    try {
      sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, sequence) => {
        let frame;
        try {
          if (!active || !Number.isSafeInteger(sequence) || sequence <= newest) return;
          newest = sequence;
          if (inFlight) return;
          frame = importedSharedTexture.getVideoFrame();
          port.postMessage(frame, [frame]);
          inFlight = true;
        } catch {
          ended("unavailable");
        } finally {
          frame?.close();
          importedSharedTexture.release();
        }
      });
      ipcRenderer.send("rooms:capture-owner-native-ready");
    } catch {
      port.close();
      ended("unavailable");
    }
  }

  window.addEventListener("message", connectNativeFrames);
}
