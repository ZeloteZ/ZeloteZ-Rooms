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

  function t(en, de, zh) { return language === "zh-CN" ? zh : language === "de" ? de : en; }

  function render() {
    document.documentElement.lang = language;
    document.body.dataset.settingsView = editing ? state.currentOrigin ? "server" : "setup" : "preferences";
    control("heading").textContent = editing
      ? state.currentOrigin ? t("Change server", "Server wechseln", "更换服务器") : t("Connect to your server", "Mit deinem Server verbinden", "连接到服务器")
      : t("Desktop settings", "Desktop-Einstellungen", "桌面设置");
    control("description").textContent = editing
      ? state.currentOrigin
        ? t("Your current room stays open until you connect to the new server.", "Dein aktueller Raum bleibt offen, bis du dich mit dem neuen Server verbindest.", "当前房间会一直保持打开，直到你连接到新服务器。")
        : t("Enter the Rooms address your host shared with you.", "Gib die Rooms-Adresse ein, die dir der Betreiber gegeben hat.", "请输入管理员提供的 Rooms 地址。")
      : t("These preferences apply to this device.", "Diese Einstellungen gelten für dieses Gerät.", "这些设置仅适用于此设备。");
    control("settings-tabs").setAttribute("aria-label", t("Settings sections", "Einstellungsbereiche", "设置分类"));
    control("general-settings-tab").textContent = t("General", "Allgemein", "常规");
    control("update-settings-tab").textContent = t("Desktop updates", "Desktop-Updates", "桌面版更新");
    control("general-settings-tab").setAttribute("aria-pressed", String(!updatesTab));
    control("update-settings-tab").setAttribute("aria-pressed", String(updatesTab));
    control("general-preferences").hidden = updatesTab;
    control("update-preferences").hidden = !updatesTab;
    control("display-heading").textContent = t("Display", "Anzeige", "显示");
    control("language-label").textContent = t("App language", "App-Sprache", "应用语言");
    control("language-detail").textContent = t("Menus and desktop dialogs", "Menüs und Desktop-Dialoge", "菜单和桌面对话框");
    control("appearance-label").textContent = t("Appearance", "Erscheinungsbild", "外观");
    control("appearance-detail").textContent = t("Desktop dialogs", "Desktop-Dialoge", "桌面对话框");
    control("background-heading").textContent = t("Background activity", "Hintergrundaktivität", "后台活动");
    control("notifications-label").textContent = t("System notifications", "Systembenachrichtigungen", "系统通知");
    control("notifications-detail").textContent = t("Show new activity while the app is running", "Neue Aktivitäten anzeigen, solange die App läuft", "应用运行时显示新动态");
    control("keep-running-label").textContent = t("Keep Rooms running", "Rooms weiterlaufen lassen", "保持 Rooms 运行");
    control("keep-running-detail").textContent = t("Keep calls and streams active when you close the window", "Anrufe und Streams beim Schließen des Fensters fortsetzen", "关闭窗口时继续通话和直播");
    control("updates-heading").textContent = t("Desktop updates", "Desktop-Updates", "桌面版更新");
    control("update-checks-label").textContent = t("Notify me about updates", "Über Updates benachrichtigen", "通知我有可用更新");
    control("update-checks-detail").textContent = t("Check GitHub for new desktop versions.", "Auf GitHub nach neuen Desktop-Versionen suchen.", "在 GitHub 上检查桌面版更新。");
    control("update-interval-label").textContent = t("Check frequency", "Prüfintervall", "检查频率");
    const intervals = [t("Hourly", "Stündlich", "每小时"), t("Every 6 hours", "Alle 6 Stunden", "每 6 小时"), t("Daily", "Täglich", "每天"), t("Weekly", "Wöchentlich", "每周")];
    intervals.forEach((label, index) => { control("updateInterval").options[index].textContent = label; });
    checkUpdate.textContent = t("Check now", "Jetzt prüfen", "立即检查");
    openRelease.textContent = t("Open GitHub Releases", "GitHub-Releases öffnen", "打开 GitHub 发布页面");
    renderUpdateControls();
    control("connection-heading").textContent = t("Connection", "Verbindung", "连接");
    control("current-server-label").textContent = t("Current server", "Aktueller Server", "当前服务器");
    control("current-server").textContent = state.currentOrigin || t("Not connected", "Nicht verbunden", "未连接");
    control("change-server").textContent = state.currentOrigin ? t("Change…", "Wechseln …", "更换…") : t("Set address…", "Adresse eingeben …", "设置地址…");
    control("done").textContent = state.currentOrigin ? t("Done", "Fertig", "完成") : t("Continue setup", "Einrichtung fortsetzen", "继续设置");
    control("address-label").textContent = t("Server address", "Serveradresse", "服务器地址");
    control("language").options[0].textContent = t("System", "System", "跟随系统");
    control("appearance").options[0].textContent = t("Dark", "Dunkel", "深色");
    control("appearance").options[1].textContent = t("System", "System", "跟随系统");
    control("appearance").options[2].textContent = t("Light", "Hell", "浅色");
    preferenceStatus.textContent = t("This preference couldn’t be saved.", "Diese Einstellung konnte nicht gespeichert werden.", "无法保存此设置。");
    check.textContent = phase === "checking" ? t("Checking…", "Wird geprüft …", "正在检查…") : t("Check address", "Adresse prüfen", "检查地址");
    connect.textContent = phase === "connecting" ? t("Connecting…", "Verbindung wird hergestellt …", "正在连接…") : t("Connect", "Verbinden", "连接");
    back.textContent = state.currentOrigin ? t("Back", "Zurück", "返回") : t("Desktop settings", "Desktop-Einstellungen", "桌面设置");

    const messages = {
      hint: t("Rooms checks the address before you connect.", "Rooms prüft die Adresse, bevor du dich verbindest.", "Rooms 会在连接前检查服务器地址。"),
      invalid: t("Enter an HTTPS server address without a path.", "Gib eine HTTPS-Serveradresse ohne Pfad ein.", "请输入不含路径的 HTTPS 服务器地址。"),
      unreachable: t("The server couldn’t be reached securely. Check the address and your connection.", "Der Server konnte nicht sicher erreicht werden. Prüfe die Adresse und deine Verbindung.", "无法安全地连接服务器，请检查地址和网络连接。"),
      not_rooms: t("This address didn’t identify itself as a ZeloteZ Rooms server.", "Unter dieser Adresse wurde kein ZeloteZ-Rooms-Server erkannt.", "此地址未被识别为 ZeloteZ Rooms 服务器。"),
      incompatible: t("This server doesn’t support this desktop client. Ask the server administrator to check its version.", "Dieser Server unterstützt diesen Desktop-Client nicht. Bitte den Betreiber, die Version zu prüfen.", "此服务器不支持当前桌面客户端，请联系服务器管理员检查版本。"),
      unavailable: t("Couldn’t verify this address as a compatible ZeloteZ Rooms server. Check the address or ask the server administrator.",
        "Diese Adresse konnte nicht als kompatibler ZeloteZ-Rooms-Server bestätigt werden. Prüfe die Adresse oder frag beim Betreiber nach.", "无法确认此地址是兼容的 ZeloteZ Rooms 服务器。请检查地址或联系服务器管理员。"),
      current: t("You’re already connected to this server.", "Mit diesem Server bist du bereits verbunden.", "你已连接到此服务器。"),
      verified: t("%s passed the Rooms check. Only connect if you trust this server.", "%s hat die Rooms-Prüfung bestanden. Verbinde dich nur, wenn du dem Server vertraust.", "%s 已通过 Rooms 检查。请仅在信任此服务器时连接。").replace("%s", () => verifiedOrigin),
      changed: t("The check expired. Check the address again.", "Die Prüfung ist abgelaufen. Prüfe die Adresse erneut.", "检查结果已过期，请重新检查地址。"),
      load: t("The server couldn’t be opened safely. Check the address again.", "Der Server konnte nicht sicher geöffnet werden. Prüfe die Adresse erneut.", "无法安全地打开服务器，请重新检查地址。"),
      save: t("The server address couldn’t be saved.", "Die Serveradresse konnte nicht gespeichert werden.", "无法保存服务器地址。"),
    };
    status.textContent = messages[statusKey] ?? messages.unavailable;
    status.className = "status" + (["hint", "current"].includes(statusKey) ? "" : statusKey === "verified" ? " success" : " error");
    const busy = phase !== "idle";
    if (busy) {
      status.className = "status pending";
      status.textContent = phase === "checking"
        ? t("Checking the server address…", "Die Serveradresse wird geprüft …", "正在检查服务器地址…")
        : t("Opening your Rooms server…", "Dein Rooms-Server wird geöffnet …", "正在打开 Rooms 服务器…");
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
    checkUpdate.disabled = updating;
    openRelease.classList.toggle("primary", updateResult?.status === "available");
    const statuses = {
      unavailable: t("GitHub didn’t provide update information. To view private releases, sign in to GitHub in your browser.",
        "GitHub hat keine Update-Informationen geliefert. Melde dich für private Releases im Browser bei GitHub an.", "GitHub 未提供更新信息。若要查看私有版本，请在浏览器中登录 GitHub。"),
      current: t("You’re using the latest version.", "Du verwendest die neueste Version.", "当前已是最新版本。"),
      available: (updateResult?.installer ? t("Version {version} is available.", "Version {version} ist verfügbar.", "{version} 版本已可用。")
        : t("Version {version} has been published. This release contains no installer for your platform.",
          "Version {version} wurde veröffentlicht. Dieses Release enthält keinen Installer für deine Plattform.", "{version} 版本已发布，但未提供适用于当前平台的安装程序。"))
        .replace("{version}", updateResult?.version ?? ""),
    };
    const message = updating ? t("One moment…", "Einen Moment …", "请稍候…") : statuses[updateResult?.status] ?? "";
    updateStatus.textContent = message;
    updateStatus.hidden = !message;
    updateStatus.classList.toggle("error", updateResult?.status === "unavailable");
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
  checkUpdate.addEventListener("click", async () => {
    if (updating) return;
    updating = true;
    updateResult = undefined;
    renderUpdateControls();
    try {
      updateResult = await bridge.checkUpdate();
    } catch {
      updateResult = { status: "unavailable" };
    } finally {
      updating = false;
      render();
    }
  });
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
  if (state.mode === "share") {
    window.roomsShare(state);
    return;
  }
  if (state.mode === "settings") {
    settings(state);
    return;
  }
  const t = (en, de, zh) => state.language === "zh-CN" ? zh : state.language === "de" ? de : en;
  document.documentElement.lang = state.language;
  if (state.mode === "update-intro") {
    document.body.dataset.settingsView = "update-intro";
    control("heading").textContent = t("Desktop update notifications", "Desktop-Update-Hinweise", "桌面版更新通知");
    control("description").textContent = t("Choose whether to check for new desktop versions.", "Du entscheidest, ob Rooms nach neuen Desktop-Versionen sucht.", "选择是否检查桌面版更新。");
    control("update-intro-details").textContent = t(
      "Update checks are off by default. Turn them on in Desktop settings to check GitHub for new versions.",
      "Die Update-Prüfung ist standardmäßig aus. Schalte sie in den Desktop-Einstellungen ein, um auf GitHub nach neuen Versionen zu suchen.", "更新检查默认关闭。你可以在桌面设置中开启，以便在 GitHub 上检查新版本。");
    const dismiss = control("dismiss-update-intro");
    const settings = control("open-update-settings");
    dismiss.textContent = t("Not now", "Jetzt nicht", "暂不");
    settings.textContent = t("Open settings", "Einstellungen öffnen", "打开设置");
    dismiss.addEventListener("click", () => void bridge.updateIntro("dismiss"));
    settings.addEventListener("click", () => void bridge.updateIntro("settings"));
    document.addEventListener("keydown", event => { if (event.key === "Escape") void bridge.updateIntro("dismiss"); });
    control("update-intro").hidden = false;
    dismiss.focus();
    return;
  }
  control("picker-cancel").textContent = t("Cancel", "Abbrechen", "取消");
  control("picker-cancel").addEventListener("click", () => bridge.cancel());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") bridge.cancel();
  });

  const audio = state.mode === "audio";
  const system = state.audioMode === "system";
  control("heading").textContent = audio
    ? system ? t("Choose a playback device", "Wiedergabegerät auswählen", "选择播放设备") : t("Choose application audio", "Anwendungston auswählen", "选择应用音频")
    : t("What do you want to share?", "Was möchtest du teilen?", "你想共享什么？");
  control("description").textContent = audio
    ? system ? t("The stream will include everything you hear on this device.",
      "Der Stream enthält alles, was du über dieses Gerät hörst.", "直播将包含此设备播放的所有声音。") : t("The stream will include audio from the selected output.",
      "Der Stream enthält den Ton der ausgewählten Anwendungsausgabe.", "直播将包含所选音频输出的声音。")
    : t("Select a screen or a window.", "Wähle einen Bildschirm oder ein Fenster.", "选择一个屏幕或窗口。");
  const share = control("share");
  share.textContent = t("Share", "Teilen", "共享");
  const sources = control("sources");
  sources.setAttribute("aria-label", audio ? t("Audio sources", "Tonquellen", "音频来源") : t("Capture sources", "Aufnahmequellen", "采集来源"));
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
      kind.textContent = source.kind === "screen" ? t("Screen", "Bildschirm", "屏幕") : t("Window", "Fenster", "窗口");
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
    error.textContent = t("That source could not be selected.", "Die Quelle konnte nicht ausgewählt werden.", "无法选择此来源。");
    error.hidden = false;
    share.disabled = false;
  });
  control("source-picker").hidden = false;
  sources.firstElementChild?.focus();
}

setup().catch(() => bridge.cancel());
