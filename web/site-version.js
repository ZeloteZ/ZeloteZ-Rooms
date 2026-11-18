import { t } from "./i18n.js";

const versionPattern = /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}$/u;
let siteRelease;

export function isDesktopApp() {
  return window.roomsDesktop === true || Boolean(window.webkit?.messageHandlers?.roomsCapture);
}

export async function bundledRelease(signal) {
  const response = await fetch("/desktop-release.json", { signal, credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok) return null;
  const release = await response.json();
  if (release?.product !== "zelotez-rooms" || release.protocol !== 1 ||
      typeof release.version !== "string" || !versionPattern.test(release.version) || !Array.isArray(release.artifacts)) return null;
  return release;
}

export async function showSiteVersion() {
  const label = document.getElementById("site-version");
  if (!label || isDesktopApp()) return;
  const release = await (siteRelease ??= bundledRelease().catch(() => null));
  if (!release) {
    siteRelease = undefined;
    return;
  }
  label.textContent = t("Version {version}", "Version {version}", { version: release.version });
  label.hidden = false;
}
