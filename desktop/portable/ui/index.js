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
  const updateToken = control("update-token");
  const saveToken = control("save-update-token");
  const removeToken = control("remove-update-token");
  const checkUpdate = control("check-update");
  const openRelease = control("open-release");
  const updateStatus = control("update-status");
  let language = state.language;
  let phase = "idle";
  let verifiedOrigin = "";
  let statusKey = state.error || "hint";
  let editing = !state.currentOrigin && !state.focusUpdates;
  let updatesTab = Boolean(state.focusUpdates);
  let updating = false;
  let updateResult;

  function t(en, de) { return language === "de" ? de : en; }

  function render() {
    document.documentElement.lang = language;
    document.body.dataset.settingsView = editing ? state.currentOrigin ? "server" : "setup" : "preferences";
    control("heading").textContent = editing
      ? state.currentOrigin ? t("Change server", "Server wechseln") : t("Connect to your server", "Mit deinem Server verbinden")
      : t("Desktop settings", "Desktop-Einstellungen");
    control("description").textContent = editing
      ? state.currentOrigin
        ? t("Your current room stays open until you connect to the new server.", "Dein aktueller Raum bleibt offen, bis du dich mit dem neuen Server verbindest.")
        : t("Enter the Rooms address your host shared with you.", "Gib die Rooms-Adresse ein, die dir der Betreiber gegeben hat.")
      : t("These preferences apply to this device.", "Diese Einstellungen gelten für dieses Gerät.");
    control("settings-tabs").setAttribute("aria-label", t("Settings sections", "Einstellungsbereiche"));
    control("general-settings-tab").textContent = t("General", "Allgemein");
    control("update-settings-tab").textContent = t("Desktop updates", "Desktop-Updates");
    control("general-settings-tab").setAttribute("aria-pressed", String(!updatesTab));
    control("update-settings-tab").setAttribute("aria-pressed", String(updatesTab));
    control("general-preferences").hidden = updatesTab;
    control("update-preferences").hidden = !updatesTab;
    control("display-heading").textContent = t("Display", "Anzeige");
    control("language-label").textContent = t("App language", "App-Sprache");
    control("language-detail").textContent = t("Menus and desktop dialogs", "Menüs und Desktop-Dialoge");
    control("appearance-label").textContent = t("Appearance", "Erscheinungsbild");
    control("appearance-detail").textContent = t("Desktop dialogs", "Desktop-Dialoge");
    control("background-heading").textContent = t("Background activity", "Hintergrundaktivität");
    control("notifications-label").textContent = t("System notifications", "Systembenachrichtigungen");
    control("notifications-detail").textContent = t("Show new activity while the app is running", "Neue Aktivitäten anzeigen, solange die App läuft");
    control("keep-running-label").textContent = t("Keep Rooms running", "Rooms weiterlaufen lassen");
    control("keep-running-detail").textContent = t("Keep calls and streams active when you close the window", "Anrufe und Streams beim Schließen des Fensters fortsetzen");
    control("updates-heading").textContent = t("Desktop updates", "Desktop-Updates");
    control("update-checks-label").textContent = t("Notify me about updates", "Über Updates benachrichtigen");
    control("update-checks-detail").textContent = t("Check official GitHub releases while Rooms is running.", "Offizielle GitHub-Releases prüfen, solange Rooms läuft.");
    control("update-interval-label").textContent = t("Check frequency", "Prüfintervall");
    const intervals = [t("Hourly", "Stündlich"), t("Every 6 hours", "Alle 6 Stunden"), t("Daily", "Täglich"), t("Weekly", "Wöchentlich")];
    intervals.forEach((label, index) => { control("updateInterval").options[index].textContent = label; });
    control("update-token-label").textContent = state.updateTokenSaved ? t("GitHub token saved", "GitHub-Token gespeichert") : t("GitHub access token", "GitHub-Zugriffstoken");
    control("update-token-detail").textContent = t(
      "Use a fine-grained token with read-only Contents access to ZeloteZ/ZeloteZ-Rooms.",
      "Verwende einen Fine-grained-Token mit Leserechten für „Contents“ in ZeloteZ/ZeloteZ-Rooms.");
    updateToken.placeholder = state.updateTokenSaved ? t("Replace saved token", "Gespeicherten Token ersetzen") : "github_pat_…";
    saveToken.textContent = t("Save token", "Token speichern");
    removeToken.textContent = t("Remove token", "Token entfernen");
    checkUpdate.textContent = t("Check now", "Jetzt prüfen");
    openRelease.textContent = t("View release on GitHub", "Release auf GitHub ansehen");
    renderUpdateControls();
    control("connection-heading").textContent = t("Connection", "Verbindung");
    control("current-server-label").textContent = t("Current server", "Aktueller Server");
    control("current-server").textContent = state.currentOrigin || t("Not connected", "Nicht verbunden");
    control("change-server").textContent = state.currentOrigin ? t("Change…", "Wechseln …") : t("Set address…", "Adresse eingeben …");
    control("done").textContent = state.currentOrigin ? t("Done", "Fertig") : t("Continue setup", "Einrichtung fortsetzen");
    control("address-label").textContent = t("Server address", "Serveradresse");
    control("language").options[0].textContent = t("System", "System");
    control("appearance").options[0].textContent = t("Dark", "Dunkel");
    control("appearance").options[1].textContent = t("System", "System");
    control("appearance").options[2].textContent = t("Light", "Hell");
    preferenceStatus.textContent = t("This preference couldn’t be saved.", "Diese Einstellung konnte nicht gespeichert werden.");
    check.textContent = phase === "checking" ? t("Checking…", "Wird geprüft …") : t("Check address", "Adresse prüfen");
    connect.textContent = phase === "connecting" ? t("Connecting…", "Verbindung wird hergestellt …") : t("Connect", "Verbinden");
    back.textContent = state.currentOrigin ? t("Back", "Zurück") : t("Desktop settings", "Desktop-Einstellungen");

    const messages = {
      hint: t("Rooms checks the address before you connect.", "Rooms prüft die Adresse, bevor du dich verbindest."),
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
    if (busy) {
      status.className = "status pending";
      status.textContent = phase === "checking"
        ? t("Checking the server address…", "Die Serveradresse wird geprüft …")
        : t("Opening your Rooms server…", "Dein Rooms-Server wird geöffnet …");
    }
    address.disabled = busy;
    address.setAttribute("aria-invalid", String(statusKey === "invalid"));
    check.disabled = busy;
    check.classList.toggle("primary", !verifiedOrigin);
    connect.hidden = !verifiedOrigin;
    connect.disabled = busy || !verifiedOrigin;
    back.hidden = false;
    back.disabled = busy;
    form.hidden = !editing;
    overview.hidden = editing;
  }

  function renderUpdateControls() {
    updateToken.disabled = updating;
    saveToken.disabled = updating || !updateToken.value.trim();
    removeToken.hidden = !state.updateTokenSaved;
    removeToken.disabled = updating;
    checkUpdate.disabled = updating || !state.updateTokenSaved;
    openRelease.hidden = updateResult?.status !== "available";
    const statuses = {
      saved: t("The token was saved in your system’s secure storage.", "Der Token wurde im sicheren Speicher deines Systems abgelegt."),
      removed: t("The saved token was removed.", "Der gespeicherte Token wurde entfernt."),
      invalid: t("Enter a GitHub fine-grained personal access token.", "Gib einen persönlichen Fine-grained-Token von GitHub ein."),
      secureStorage: t("Your system’s secure storage is unavailable. Check your keychain or credential manager.",
        "Der sichere Systemspeicher ist nicht verfügbar. Prüfe deinen Schlüsselbund oder die Anmeldeinformationsverwaltung."),
      access: t("GitHub denied access. Check the token’s repository permissions and expiry.",
        "GitHub hat den Zugriff verweigert. Prüfe die Repository-Berechtigungen und das Ablaufdatum des Tokens."),
      token: t("Unlock the system credential store or add a GitHub token.", "Entsperre den sicheren Systemspeicher oder füge einen GitHub-Token hinzu."),
      unavailable: t("The update check couldn’t finish. Try again later.", "Die Update-Prüfung konnte nicht abgeschlossen werden. Versuch es später erneut."),
      current: t("You’re using the latest version.", "Du verwendest die neueste Version."),
      available: (updateResult?.installer ? t("Version {version} is available.", "Version {version} ist verfügbar.")
        : t("Version {version} has been published. This release contains no installer for your platform.",
          "Version {version} wurde veröffentlicht. Dieses Release enthält keinen Installer für deine Plattform."))
        .replace("{version}", updateResult?.version ?? ""),
    };
    const message = updating ? t("One moment…", "Einen Moment …") : statuses[updateResult?.status] ?? "";
    updateStatus.textContent = message;
    updateStatus.hidden = !message;
    updateStatus.classList.toggle("error", ["invalid", "access", "secureStorage", "unavailable"].includes(updateResult?.status));
  }

  address.value = state.address;
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
    updatesTab = false;
    render();
    control("change-server").focus();
  }
  function showServer() {
    address.value = state.currentOrigin || state.address;
    editing = true;
    verifiedOrigin = "";
    statusKey = "hint";
    render();
    address.select();
  }
  function focusUpdateSettings() {
    if (phase !== "idle") return;
    editing = false;
    updatesTab = true;
    render();
    control("updateChecks").focus();
    control("updates-heading").scrollIntoView({ block: "nearest" });
  }
  control("done").addEventListener("click", () => state.currentOrigin ? bridge.cancel() : showServer());
  control("change-server").addEventListener("click", showServer);
  back.addEventListener("click", showOverview);
  bridge.onFocusUpdates(focusUpdateSettings);
  control("general-settings-tab").addEventListener("click", () => { updatesTab = false; render(); });
  control("update-settings-tab").addEventListener("click", () => { updatesTab = true; render(); });
  updateToken.addEventListener("input", renderUpdateControls);
  async function updateOperation(operation) {
    if (updating) return;
    updating = true;
    updateResult = undefined;
    renderUpdateControls();
    try {
      updateResult = await operation();
      if (typeof updateResult?.tokenSaved === "boolean") state.updateTokenSaved = updateResult.tokenSaved;
    } catch {
      updateResult = { status: "unavailable" };
    } finally {
      updating = false;
      render();
    }
  }
  saveToken.addEventListener("click", () => {
    const token = updateToken.value.trim();
    updateToken.value = "";
    if (token) void updateOperation(() => bridge.updateToken("save", token));
  });
  removeToken.addEventListener("click", () => void updateOperation(() => bridge.updateToken("remove")));
  checkUpdate.addEventListener("click", () => void updateOperation(bridge.checkUpdate));
  openRelease.addEventListener("click", () => void bridge.openRelease());
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
      (verifiedOrigin ? connect : address).focus();
    }
  });
  connect.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
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
  if (state.focusUpdates) focusUpdateSettings();
  else if (editing) address.focus();
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
  if (state.mode === "update-intro") {
    document.body.dataset.settingsView = "update-intro";
    control("heading").textContent = t("Desktop update notifications", "Desktop-Update-Hinweise");
    control("description").textContent = t("Choose whether Rooms checks GitHub for new versions.", "Du entscheidest, ob Rooms auf GitHub nach neuen Versionen sucht.");
    control("update-intro-details").textContent = t(
      "Update checks are off by default. In Desktop settings, you can turn them on, change the frequency and set up access to the private release page.",
      "Die Update-Prüfung ist standardmäßig aus. In den Desktop-Einstellungen kannst du sie einschalten, das Prüfintervall wählen und den Zugriff auf die private Release-Seite einrichten.");
    const dismiss = control("dismiss-update-intro");
    const settings = control("open-update-settings");
    dismiss.textContent = t("Not now", "Jetzt nicht");
    settings.textContent = t("Open settings", "Einstellungen öffnen");
    dismiss.addEventListener("click", () => void bridge.updateIntro("dismiss"));
    settings.addEventListener("click", () => void bridge.updateIntro("settings"));
    document.addEventListener("keydown", event => { if (event.key === "Escape") void bridge.updateIntro("dismiss"); });
    control("update-intro").hidden = false;
    dismiss.focus();
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
