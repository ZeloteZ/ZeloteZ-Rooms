"use strict";

const control = id => document.getElementById(id);
const bridge = window.roomsLocal;

function settings(state) {
  const overview = control("preferences");
  const form = control("server-form");
  const address = control("address");
  const check = control("check");
  const connect = control("connect");
  const back = control("back");
  const status = control("address-status");
  const preferenceStatus = control("preferences-status");
  let language = state.language;
  let phase = "idle";
  let verifiedOrigin = "";
  let statusKey = state.error || "hint";
  let editing = !state.currentOrigin;

  function t(en, de) { return language === "de" ? de : en; }

  function render() {
    document.documentElement.lang = language;
    control("heading").textContent = editing
      ? state.currentOrigin ? t("Change server", "Server wechseln") : t("Connect to ZeloteZ Rooms", "Mit ZeloteZ Rooms verbinden")
      : t("Desktop settings", "Desktop-Einstellungen");
    control("description").textContent = editing
      ? state.currentOrigin
        ? t("Your current room stays open until you connect to the new server.", "Dein aktueller Raum bleibt offen, bis du dich mit dem neuen Server verbindest.")
        : t("Enter the address of your ZeloteZ Rooms server to get started.", "Gib zunächst die Adresse deines ZeloteZ-Rooms-Servers ein.")
      : t("These preferences apply to this device.", "Diese Einstellungen gelten für dieses Gerät.");
    control("language-label").textContent = t("App language", "App-Sprache");
    control("language-detail").textContent = t("Menus and desktop dialogs", "Menüs und Desktop-Dialoge");
    control("appearance-label").textContent = t("Appearance", "Erscheinungsbild");
    control("appearance-detail").textContent = t("Desktop dialogs", "Desktop-Dialoge");
    control("notifications-label").textContent = t("System notifications", "Systembenachrichtigungen");
    control("notifications-detail").textContent = t("Show new activity while the app is running", "Neue Aktivitäten anzeigen, solange die App läuft");
    control("keep-running-label").textContent = t("Keep Rooms running", "Rooms weiterlaufen lassen");
    control("keep-running-detail").textContent = t("Keep calls and streams active when you close the window", "Anrufe und Streams beim Schließen des Fensters fortsetzen");
    control("current-server-label").textContent = t("Current server", "Aktueller Server");
    control("change-server").textContent = t("Change…", "Wechseln …");
    control("done").textContent = t("Done", "Fertig");
    control("address-label").textContent = t("Server address", "Serveradresse");
    control("language").options[0].textContent = t("System", "System");
    control("appearance").options[0].textContent = t("Dark", "Dunkel");
    control("appearance").options[1].textContent = t("System", "System");
    control("appearance").options[2].textContent = t("Light", "Hell");
    preferenceStatus.textContent = t("This preference couldn’t be saved.", "Diese Einstellung konnte nicht gespeichert werden.");
    check.textContent = phase === "checking" ? t("Checking…", "Wird geprüft …") : t("Check address", "Adresse prüfen");
    connect.textContent = phase === "connecting" ? t("Connecting…", "Verbindung wird hergestellt …") : t("Connect", "Verbinden");
    back.textContent = t("Back", "Zurück");

    const messages = {
      hint: t("The address is checked before anything opens.", "Die Adresse wird geprüft, bevor etwas geöffnet wird."),
      invalid: t("Enter an HTTPS server address without a path.", "Gib eine HTTPS-Serveradresse ohne Pfad ein."),
      unreachable: t("The server couldn’t be reached securely. Check the address and your connection.", "Der Server konnte nicht sicher erreicht werden. Prüfe die Adresse und deine Verbindung."),
      not_rooms: t("This address didn’t identify itself as a ZeloteZ Rooms server.", "Unter dieser Adresse wurde kein ZeloteZ-Rooms-Server erkannt."),
      incompatible: t("This server doesn’t support this desktop client. Ask the server administrator to check its version.", "Dieser Server unterstützt diesen Desktop-Client nicht. Bitte den Betreiber, die Version zu prüfen."),
      unavailable: t("Couldn’t verify this address as a compatible ZeloteZ Rooms server. Check the address or ask the server administrator.",
        "Diese Adresse konnte nicht als kompatibler ZeloteZ-Rooms-Server bestätigt werden. Prüfe die Adresse oder frag beim Betreiber nach."),
      current: t("You’re already connected to this server.", "Mit diesem Server bist du bereits verbunden."),
      verified: t("%s passed the Rooms check. Only connect if you trust this server.", "%s hat die Rooms-Prüfung bestanden. Verbinde dich nur, wenn du dem Server vertraust.").replace("%s", () => verifiedOrigin),
      changed: t("The check expired. Check the address again.", "Die Prüfung ist abgelaufen. Prüfe die Adresse erneut."),
      load: t("The server couldn’t be opened safely. Check the address again.", "Der Server konnte nicht sicher geöffnet werden. Prüfe die Adresse erneut."),
      save: t("The server address couldn’t be saved.", "Die Serveradresse konnte nicht gespeichert werden."),
    };
    status.textContent = messages[statusKey] ?? messages.unavailable;
    status.className = "status" + (["hint", "current"].includes(statusKey) ? "" : statusKey === "verified" ? " success" : " error");
    const busy = phase !== "idle";
    address.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    check.disabled = busy;
    check.classList.toggle("primary", !verifiedOrigin);
    connect.hidden = !verifiedOrigin;
    connect.disabled = busy || !verifiedOrigin;
    back.hidden = !state.currentOrigin;
    back.disabled = busy;
    form.hidden = !editing;
    overview.hidden = editing;
  }

  address.value = state.address;
  control("current-server").textContent = state.currentOrigin;
  for (const id of Object.keys(state.preferences)) {
    const field = control(id);
    const property = field.type === "checkbox" ? "checked" : "value";
    field[property] = state.preferences[id];
    field.addEventListener("change", async () => {
      const oldValue = state.preferences[id];
      const newValue = field[property];
      field.disabled = true;
      preferenceStatus.hidden = true;
      try {
        const result = await bridge.preference(id, newValue);
        if (!result) throw new Error();
        state.preferences[id] = newValue;
        language = result.language;
        render();
      } catch {
        field[property] = oldValue;
        preferenceStatus.hidden = false;
      } finally {
        field.disabled = false;
      }
    });
  }
  function showOverview() {
    editing = false;
    render();
    control("change-server").focus();
  }
  control("done").addEventListener("click", () => bridge.cancel());
  control("change-server").addEventListener("click", () => {
    address.value = state.currentOrigin;
    editing = true;
    verifiedOrigin = "";
    statusKey = "hint";
    render();
    address.select();
  });
  back.addEventListener("click", showOverview);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || phase === "connecting") return;
    if (editing && state.currentOrigin && phase === "idle") showOverview();
    else if (!editing) bridge.cancel();
  });
  address.addEventListener("input", () => {
    verifiedOrigin = "";
    statusKey = "hint";
    render();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (phase !== "idle") return;
    phase = "checking";
    verifiedOrigin = "";
    statusKey = "hint";
    render();
    try {
      const result = await bridge.check(address.value);
      verifiedOrigin = result?.origin ?? "";
      statusKey = verifiedOrigin ? "verified" : result?.error ?? "unavailable";
    } catch {
      statusKey = "unavailable";
    } finally {
      phase = "idle";
      render();
      check.focus();
    }
  });
  connect.addEventListener("click", async () => {
    if (!verifiedOrigin || phase !== "idle") return;
    phase = "connecting";
    render();
    try {
      const result = await bridge.connect(address.value);
      if (result === true) return;
      statusKey = result?.error ?? "unavailable";
    } catch {
      statusKey = "unavailable";
    }
    phase = "idle";
    verifiedOrigin = "";
    render();
    address.focus();
  });
  render();
  if (editing) address.focus();
  else control("language").focus();
}

async function setup() {
  const state = await bridge.state();
  if (!state) return;
  if (state.mode === "settings") {
    settings(state);
    return;
  }
  const t = (en, de) => state.language === "de" ? de : en;
  document.documentElement.lang = state.language;
  if (state.mode === "tray-hint") {
    control("heading").textContent = t("Minimize ZeloteZ Rooms?", "ZeloteZ Rooms minimieren?");
    control("description").textContent = t("Rooms stays open in the background so calls and streams can continue.", "Rooms bleibt im Hintergrund geöffnet. Anrufe und Streams laufen weiter.");
    control("tray-note").textContent = state.hasTray
      ? t("Use the Rooms icon in the system tray to reopen the window.", "Über das Rooms-Symbol im Infobereich öffnest du das Fenster wieder.")
      : t("Use the taskbar to reopen the window.", "Über die Taskleiste öffnest du das Fenster wieder.");
    control("tray-suppress-label").textContent = t("Don’t show again", "Nicht wieder anzeigen");
    const quit = control("tray-quit");
    const confirm = control("tray-confirm");
    quit.textContent = t("Quit completely", "Ganz schließen");
    confirm.textContent = "OK";
    function selectAction(action) {
      bridge.closeAction(action, control("tray-suppress").checked);
    }
    quit.addEventListener("click", () => selectAction("quit"));
    confirm.addEventListener("click", () => selectAction("minimize"));
    document.addEventListener("keydown", event => { if (event.key === "Escape") bridge.cancel(); });
    control("tray-hint").hidden = false;
    confirm.focus();
    return;
  }
  control("picker-cancel").textContent = t("Cancel", "Abbrechen");
  control("picker-cancel").addEventListener("click", () => bridge.cancel());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") bridge.cancel();
  });

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
