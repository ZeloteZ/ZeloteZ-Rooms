"use strict";

const control = id => document.getElementById(id);
const bridge = window.roomsLocal;

async function setup() {
  const state = await bridge.state();
  if (!state) return;
  const t = (en, de) => state.language === "de" ? de : en;
  document.documentElement.lang = state.language;
  for (const id of ["server-cancel", "picker-cancel"]) {
    control(id).textContent = t("Cancel", "Abbrechen");
    control(id).addEventListener("click", () => bridge.cancel());
  }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && (state.mode !== "settings" || state.canCancel)) bridge.cancel();
  });

  if (state.mode === "settings") {
    const form = control("server-form");
    const address = control("address");
    const connect = control("connect");
    const error = control("error");
    function showError(message) {
      error.textContent = message;
      error.hidden = !message;
    }
    control("heading").textContent = t("Connect to your server", "Mit deinem Server verbinden");
    control("description").textContent = t("Enter the address of your ZeloteZ Rooms installation.", "Gib die Adresse deiner ZeloteZ-Rooms-Installation ein.");
    control("address-label").textContent = t("Server address", "Serveradresse");
    control("server-cancel").hidden = !state.canCancel;
    address.value = state.address;
    connect.textContent = t("Connect", "Verbinden");
    if (state.error) showError(t("The server could not be reached. Check its address.", "Der Server war nicht erreichbar. Prüfe die Adresse."));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      connect.disabled = true;
      try {
        showError("");
        const result = await bridge.submit(address.value);
        if (result === "invalid") showError(t("Enter an HTTPS address for your server.", "Gib die HTTPS-Adresse deines Servers ein."));
        else if (result !== true) showError(t("The server address could not be saved.", "Die Serveradresse konnte nicht gespeichert werden."));
      } finally {
        connect.disabled = false;
      }
    });
    form.hidden = false;
    address.focus();
    return;
  }

  const audio = state.mode === "audio";
  const system = state.audioMode === "system";
  control("heading").textContent = audio
    ? system ? t("Choose a playback device", "Wiedergabegerät auswählen") : t("Choose application audio", "Anwendungston auswählen")
    : t("What do you want to share?", "Was möchtest du teilen?");
  control("description").textContent = audio
    ? system ? t("The stream will include everything you hear on this device.",
      "Der Stream enthält alles, was du über dieses Gerät hörst.") : t("The stream will include audio from the selected output.",
      "Der Stream enthält den Ton der ausgewählten Anwendungsausgabe.")
    : t("Select a screen or a window.", "Wähle einen Bildschirm oder ein Fenster.");
  const share = control("share");
  share.textContent = t("Share", "Teilen");
  const sources = control("sources");
  sources.setAttribute("aria-label", audio ? t("Audio sources", "Tonquellen") : t("Capture sources", "Aufnahmequellen"));
  sources.classList.toggle("audio-sources", audio);
  let selected = null;
  for (const [index, source] of state.sources.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source";
    button.setAttribute("aria-pressed", "false");
    const label = document.createElement("strong");
    label.textContent = source.name;
    if (audio) button.append(label);
    else {
      const preview = document.createElement("div");
      preview.className = "preview";
      if (source.thumbnail) {
        const image = new Image();
        image.src = source.thumbnail;
        image.alt = "";
        preview.append(image);
      }
      const kind = document.createElement("span");
      kind.textContent = source.kind === "screen" ? t("Screen", "Bildschirm") : t("Window", "Fenster");
      button.append(preview, label, kind);
    }
    button.addEventListener("click", () => {
      selected?.button.setAttribute("aria-pressed", "false");
      selected = { index, button };
      button.setAttribute("aria-pressed", "true");
      share.disabled = false;
    });
    sources.append(button);
  }
  share.addEventListener("click", async () => {
    if (!selected) return;
    share.disabled = true;
    try {
      if (await bridge.submit(selected.index)) return;
    } catch {
      // Report a failed selection while the picker remains open.
    }
    const error = control("picker-error");
    error.textContent = t("That source could not be selected.", "Die Quelle konnte nicht ausgewählt werden.");
    error.hidden = false;
    share.disabled = false;
  });
  control("source-picker").hidden = false;
  sources.firstElementChild?.focus();
}

setup().catch(() => bridge.cancel());
