import { locale, t } from "./i18n.js";
import { api, button, el, status, tell } from "./ui.js";

export function isDesktopApp() {
  return window.roomsDesktop === true || Boolean(window.webkit?.messageHandlers?.roomsCapture);
}

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

function releaseFilePath(url, path) {
  if (typeof url !== "string") return false;
  try {
    const resolved = new URL(url, location.origin);
    return resolved.origin === location.origin && resolved.pathname === path && !resolved.search && !resolved.hash &&
      !resolved.username && !resolved.password;
  } catch {
    return false;
  }
}

function downloadEntry(release, platform) {
  const suffix = platform === "linux" ? "x86_64.AppImage" : "x64.exe";
  const path = "/downloads/desktop/" + release.version + "/ZeloteZ-Rooms-" + release.version + "-" + suffix;
  return release.downloads.find(entry => entry?.platform === platform && entry.arch === "x64" &&
    Number.isSafeInteger(entry.size) && entry.size > 0 && releaseFilePath(entry.url, path));
}

function downloadCard(platform, entry, suggested) {
  const name = platform === "linux" ? "Linux" : "Windows";
  const description = platform === "linux"
    ? t("Make the AppImage executable, then open it.", "Markiere das AppImage als ausführbar und öffne es.")
    : t("Run the installer to install Rooms.", "Öffne das Installationsprogramm, um Rooms zu installieren.");
  const fileType = platform === "linux" ? "AppImage" : t("Installer", "Installationsprogramm");
  const details = el("p", { class: "subtle" }, "x86-64 · " + fileType);
  let action;
  if (entry) {
    const size = new Intl.NumberFormat(locale(), { style: "unit", unit: "megabyte", unitDisplay: "short",
      maximumFractionDigits: 1 }).format(entry.size / 1_000_000);
    details.append(" · " + size);
    const label = platform === "linux" ? t("Download for Linux", "Für Linux herunterladen")
      : t("Download for Windows", "Für Windows herunterladen");
    action = el("a", { class: "button" + (suggested ? " primary" : ""), href: entry.url, download: "" }, label);
  } else {
    action = el("p", { class: "status", role: "status" }, t("This download is not available yet.", "Dieser Download ist noch nicht verfügbar."));
  }
  return el("section", { class: "panel download-card", "data-platform": platform },
    el("div", { class: "section-heading" }, el("h2", {}, name),
      suggested && el("span", { class: "tag" }, t("Suggested for this device", "Für dieses Gerät empfohlen"))),
    details, el("p", { class: "muted" }, description), action);
}

export function renderDownloads({ signal }) {
  const version = el("p", { class: "subtle", hidden: true });
  const cards = el("div", { class: "download-cards" });
  const verification = el("p", { class: "subtle", hidden: true });
  const feedback = status();
  const retry = button(t("Try again", "Erneut laden"), () => void load(), { hidden: true });
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
      el("h1", { id: "downloads-heading", tabindex: -1 }, t("Downloads", "Downloads")),
      version)),
    el("div", { class: "download-content" }, intro, feedback, retry, cards, verification));
  let loading = false;

  async function load() {
    if (loading || signal.aborted) return;
    loading = true;
    retry.hidden = true;
    tell(feedback, t("Loading downloads…", "Downloads werden geladen …"));
    try {
      const [release, suggested] = await Promise.all([api("desktop-downloads", { signal }), suggestedDownloadPlatform()]);
      if (signal.aborted) return;
      if (!release || typeof release.version !== "string" || !/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){2}$/u.test(release.version) ||
          !Array.isArray(release.downloads)) throw new Error();
      version.textContent = t("Version {version}", "Version {version}", { version: release.version });
      version.hidden = false;
      const platforms = suggested === "windows" ? ["windows", "linux"] : ["linux", "windows"];
      cards.replaceChildren(...platforms.map(platform => {
        const entry = downloadEntry(release, platform);
        return downloadCard(platform, entry, Boolean(entry && suggested === platform));
      }));
      const { manifestUrl, signatureUrl } = release;
      const proofBase = `/downloads/desktop/${release.version}/desktop-release-manifest.`;
      verification.hidden = !releaseFilePath(manifestUrl, proofBase + "json") ||
        !releaseFilePath(signatureUrl, proofBase + "sig");
      if (!verification.hidden) {
        verification.replaceChildren(
          el("a", { href: manifestUrl, download: "" }, t("Release manifest", "Release-Manifest")),
          " · ", el("a", { href: signatureUrl, download: "" }, t("Release signature", "Release-Signatur")));
      }
      tell(feedback, "");
    } catch (error) {
      if (signal.aborted) return;
      tell(feedback, error.status === 404
        ? t("This server has no desktop downloads yet.", "Auf diesem Server sind noch keine Desktop-Downloads verfügbar.")
        : t("Downloads are temporarily unavailable.", "Die Downloads sind vorübergehend nicht verfügbar."), "error");
      retry.hidden = false;
    } finally {
      loading = false;
    }
  }

  void load();
  return node;
}
