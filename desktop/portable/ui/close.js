"use strict";

async function setupClose() {
  const bridge = window.roomsClose;
  const state = await bridge.state();
  if (!state) return;
  const translate = (english, german, chinese) => state.language === "zh-CN" ? chinese : state.language === "de" ? german : english;
  const select = id => document.getElementById(id);
  const title = select("close-title");
  const dismiss = select("close-dismiss");
  const quit = select("close-quit");
  const confirm = select("close-confirm");
  const suppress = select("close-suppress");
  const controls = [dismiss, quit, confirm, suppress];
  let deciding = false;

  document.documentElement.lang = state.language;
  title.textContent = translate("Minimize ZeloteZ Rooms?", "ZeloteZ Rooms minimieren?", "最小化 ZeloteZ Rooms？");
  select("close-detail").textContent = translate("Calls and streams can continue in the background.",
    "Anrufe und Streams können im Hintergrund weiterlaufen.", "通话和直播可以在后台继续。");
  select("close-reopen").textContent = state.hasTray
    ? translate("Reopen the window from the Rooms icon in the system tray.",
      "Über das Rooms-Symbol im Infobereich öffnest du das Fenster wieder.", "点击系统托盘中的 Rooms 图标可重新打开窗口。")
    : translate("Reopen the window from the taskbar.", "Über die Taskleiste öffnest du das Fenster wieder.", "点击任务栏中的图标可重新打开窗口。");
  select("close-option-label").textContent = translate("Don’t show again", "Nicht wieder anzeigen", "不再显示");
  const dismissLabel = translate("Dismiss reminder", "Hinweis schließen", "关闭提醒");
  dismiss.setAttribute("aria-label", dismissLabel);
  dismiss.title = dismissLabel;
  quit.textContent = translate("Quit completely", "Ganz schließen", "完全退出");
  confirm.textContent = translate("OK", "OK", "确定");
  confirm.setAttribute("aria-label", translate("OK, minimize", "OK, minimieren", "确定，最小化"));

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
