import { desktopShareControls } from "./desktop-share.js";
import { language, t } from "./i18n.js";
import { el, field, select } from "./ui.js";

export function createChannelCapture({ room, screenShare, nativeBroadcast }, channel) {
  const legacy = window.webkit?.messageHandlers?.roomsCapture;
  const native = window.roomsNativeCapture;
  const browser = !legacy && !native;
  const unified = browser && typeof window.roomsDesktopShare?.arm === "function";
  const portable = browser && !unified && window.roomsDesktop === true ? desktopShareControls() : null;
  const audioBridge = window.roomsDesktopAudio;
  const audioModes = Array.isArray(audioBridge?.supportedModes) ? audioBridge.supportedModes : ["application", "system"];
  const portableAudio = portable && audioBridge ? select([
    ["none", t("No audio", "Kein Ton")],
    ...[
      ["application", t("Application audio", "Anwendungston")],
      ["system", t("System audio", "Systemton")],
    ].filter(([mode]) => audioModes.includes(mode)),
  ], "none") : null;
  if (portable) portable.element.hidden = false;
  if (portableAudio) portable.element.append(field(t("Stream audio", "Streamton"), portableAudio));
  const audio = el("input", { type: "checkbox" });
  const options = browser && !unified ? portable?.element ?? el("label", { class: "inline subtle" }, audio,
    t("Include tab or app audio when available", "Tab- oder Anwendungston teilen, wenn verfügbar")) : null;

  async function start() {
    if (legacy) {
      legacy.postMessage({ action: "open", channelId: channel.id, language: language() });
    } else if (native) {
      const result = nativeBroadcast ? await nativeBroadcast.open(room, channel, language()) : await native.open(channel.id, language());
      if (result === "busy") throw new Error(t("The capture controls are already open.", "Die Aufnahmesteuerung ist bereits geöffnet."));
      if (result !== "opened") throw new Error(t("The capture window couldn’t open.", "Das Aufnahmefenster konnte nicht geöffnet werden."));
    } else {
      const settings = unified ? { unified: true } : portable ? { ...portable.options(), audio: portableAudio?.value ?? "none" } : null;
      await screenShare.start(room, channel, audio.checked, settings);
    }
  }

  return { options, start };
}
