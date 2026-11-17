"use strict";

const desktopSettings = document.querySelector("#desktop-settings");

desktopSettings.addEventListener("click", event => {
  if (event.isTrusted) void window.roomsTitlebar.openSettings();
});

window.roomsTitlebar.onLanguage(language => {
  const label = language === "zh-CN" ? "桌面设置" : language === "de" ? "Desktop-Einstellungen" : "Desktop settings";
  document.documentElement.lang = language;
  desktopSettings.setAttribute("aria-label", label);
  desktopSettings.title = label;
});
