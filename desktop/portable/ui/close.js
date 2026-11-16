"use strict";

async function setupClose() {
  const bridge = window.roomsClose;
  const state = await bridge.state();
  if (!state) return;
  const translate = (english, german) => state.language === "de" ? german : english;
  const select = id => document.getElementById(id);
  const title = select("close-title");
  const dismiss = select("close-dismiss");
  const quit = select("close-quit");
  const confirm = select("close-confirm");
  const suppress = select("close-suppress");
  const controls = [dismiss, quit, confirm, suppress];
  let deciding = false;

  document.documentElement.lang = state.language;
  title.textContent = translate("Minimize ZeloteZ Rooms?", "ZeloteZ Rooms minimieren?");
  select("close-detail").textContent = translate("Calls and streams can continue in the background.",
    "Anrufe und Streams können im Hintergrund weiterlaufen.");
  select("close-reopen").textContent = state.hasTray
    ? translate("Reopen the window from the Rooms icon in the system tray.",
      "Über das Rooms-Symbol im Infobereich öffnest du das Fenster wieder.")
    : translate("Reopen the window from the taskbar.", "Über die Taskleiste öffnest du das Fenster wieder.");
  select("close-option-label").textContent = translate("Don’t show again", "Nicht wieder anzeigen");
  const dismissLabel = translate("Dismiss reminder", "Hinweis schließen");
  dismiss.setAttribute("aria-label", dismissLabel);
  dismiss.title = dismissLabel;
  quit.textContent = translate("Quit completely", "Ganz schließen");
  confirm.setAttribute("aria-label", translate("OK, minimize", "OK, minimieren"));

  async function decide(action) {
    if (deciding) return;
    deciding = true;
    for (const control of controls) control.disabled = true;
    try {
      if (await bridge.decide(action, action !== "dismiss" && suppress.checked)) return;
    } catch { /* The view can close before IPC replies. */ }
    deciding = false;
    for (const control of controls) control.disabled = false;
  }
  dismiss.addEventListener("click", () => decide("dismiss"));
  quit.addEventListener("click", () => decide("quit"));
  confirm.addEventListener("click", () => decide("minimize"));
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    void decide("dismiss");
  });
  document.querySelector(".close-dialog").hidden = false;
  confirm.focus();
}

void setupClose();
