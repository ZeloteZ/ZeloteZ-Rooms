import { t } from "./i18n.js";
import { el } from "./ui.js";
import { bundledRelease } from "./site-version.js";
export { isDesktopApp } from "./site-version.js";

const releases = "https://github.com/ZeloteZ/ZeloteZ-Rooms/releases";

export async function suggestedDownloadPlatform(browserNavigator = navigator) {
  const agent = browserNavigator.userAgent ?? "";
  const hints = browserNavigator.userAgentData;
  if (hints?.mobile || /Android|iPhone|iPad|iPod/iu.test(agent)) return null;
  const system = hints?.platform || browserNavigator.platform || agent;
  const platform = /Windows|Win32|Win64/iu.test(system) ? "windows" : /Linux/iu.test(system) ? "linux" : null;
  if (!platform) return null;
  let architecture;
  try {
    architecture = await hints?.getHighEntropyValues?.(["architecture", "bitness"]);
  } catch {
    // Fall back to the platform details exposed by browsers without these hints.
  }
  if (architecture?.architecture) {
    return architecture.architecture === "x86" && architecture.bitness === "64" ? platform : null;
  }
  const details = [browserNavigator.platform, browserNavigator.oscpu, agent].filter(Boolean).join(" ");
  if (/arm|aarch64|i[3-6]86/iu.test(details)) return null;
  return /x86_64|amd64|Win64|WOW64|\bx64\b/iu.test(details) ? platform : null;
}

function releaseAsset(version, filename) {
  return releases + "/download/v" + version + "/" + filename;
}

function downloadCard(platform, release, suggested) {
  const name = platform === "linux" ? "Linux" : "Windows";
  const description = platform === "linux"
    ? t("Make the AppImage executable, then open it.", "Markiere das AppImage als ausführbar und öffne es.")
    : t("Run the installer to install Rooms.", "Öffne das Installationsprogramm, um Rooms zu installieren.");
  const fileType = platform === "linux" ? "AppImage" : t("Installer", "Installationsprogramm");
  const label = platform === "linux" ? t("Download for Linux", "Für Linux herunterladen")
    : t("Download for Windows", "Für Windows herunterladen");
  const suffix = platform === "linux" ? "x86_64.AppImage" : "x64.exe";
  const href = release?.artifacts.includes(platform + "-x64")
    ? releaseAsset(release.version, "ZeloteZ-Rooms-" + release.version + "-" + suffix) : releases + "/latest";

  return el("section", { class: "panel download-card", "data-platform": platform },
    el("div", { class: "section-heading" }, el("h2", {}, name),
      suggested && el("span", { class: "tag" }, t("Suggested for this device", "Für dieses Gerät empfohlen"))),
    el("p", { class: "subtle" }, "x86-64 · " + fileType), el("p", { class: "muted" }, description),
    el("a", { class: "button" + (suggested ? " primary" : ""), href, rel: "noreferrer" }, label));
}

export function renderDownloads({ signal }) {
  const version = el("p", { class: "subtle", hidden: true });
  const cards = el("div", { class: "download-cards" });
  const verification = el("p", { class: "subtle", hidden: true });
  const latest = el("a", { href: releases + "/latest", rel: "noreferrer" },
    t("Latest release on GitHub", "Neueste Version auf GitHub"));
  const intro = el("div", { class: "download-intro" },
    el("h2", {}, t("Get more with the ZeloteZ Rooms client:", "Mit dem ZeloteZ Rooms Client hast du viele Vorteile:")),
    el("ul", { class: "muted" },
      el("li", {}, t("Stream individual apps with just their audio (on Windows 11 or Linux with PipeWire)",
        "Streame einzelne Anwendungen mit ausschließlich deren Audiospur (unter Windows 11 oder unter Linux mit PipeWire)")),
      el("li", {}, t("Stream an entire monitor or just a selected area. It’s up to you",
        "Streame ganze Monitore oder nur einzelne Bereiche - Du entscheidest")),
      el("li", {}, t("Get system notifications for new livestreams, direct messages, and more.",
        "Erhalte Systembenachrichtigungen bei Starts von Livestreams, Direktnachrichten und vielem mehr."))));
  const node = el("section", { class: "secondary-page downloads-page", "aria-labelledby": "downloads-heading" },
    el("header", { class: "page-heading" }, el("div", { class: "stack download-heading" },
      el("h1", { id: "downloads-heading", tabindex: -1 }, t("Downloads", "Downloads")), version), latest),
    el("div", { class: "download-content" }, intro, cards, verification));

  function showCards(release, suggested) {
    const platforms = suggested === "windows" ? ["windows", "linux"] : ["linux", "windows"];
    cards.replaceChildren(...platforms.map(platform => downloadCard(platform, release, suggested === platform)));
  }

  showCards(null, null);
  void Promise.all([bundledRelease(signal).catch(() => null), suggestedDownloadPlatform()]).then(([release, suggested]) => {
    if (signal.aborted) return;
    showCards(release, suggested);
    if (!release) return;
    version.textContent = t("Version {version}", "Version {version}", { version: release.version });
    version.hidden = false;
    verification.append(
      el("a", { href: releaseAsset(release.version, "desktop-release-manifest.json"), rel: "noreferrer" },
        t("Release manifest", "Release-Manifest")),
      " · ", el("a", { href: releaseAsset(release.version, "desktop-release-manifest.sig"), rel: "noreferrer" },
        t("Release signature", "Release-Signatur")));
    verification.hidden = false;
  });
  return node;
}
