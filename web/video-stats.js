import { locale, t } from "./i18n.js";
import { el } from "./ui.js";

let enabled = false;
const preferences = new EventTarget();

export function setVideoStatsEnabled(value) {
  const next = value === true;
  if (enabled === next) return;
  enabled = next;
  preferences.dispatchEvent(new Event("change"));
}

export function mountVideoStats(collector, signal) {
  const node = el("div", { class: "video-reception-stats", role: "group", hidden: true,
    "aria-label": t("Video reception statistics", "Video-Empfangsdaten") });
  const elapsed = el("span", { title: t("Viewing time", "Wiedergabedauer") });
  const resolution = el("span", { title: t("Received resolution", "Empfangene Auflösung") });
  const frames = el("span", { title: t("Received frame rate", "Empfangene Bildrate") });
  const rate = el("span", { title: t("Received video data", "Empfangene Videodaten") });
  node.append(elapsed, resolution, frames, rate);
  let timer;
  let generation = 0;
  let closed = false;

  async function refresh() {
    const current = generation;
    if (closed || !enabled || signal.aborted) return;
    try {
      const data = await collector.sample();
      if (closed || !enabled || signal.aborted || current !== generation) return;
      const format = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
      const rateFormat = new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 });
      const seconds = Math.max(0, Math.floor(data.elapsed ?? 0));
      elapsed.textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
      resolution.textContent = data.width > 0 && data.height > 0 ? data.width + " × " + data.height : "—";
      frames.textContent = (Number.isFinite(data.fps) ? format.format(data.fps) : "—") + " FPS";
      rate.textContent = (Number.isFinite(data.mbps) ? rateFormat.format(data.mbps) : "—") + " Mbit/s";
      node.hidden = !(data.width > 0 && data.height > 0);
    } catch {
      if (current === generation) node.hidden = true;
    } finally {
      if (!closed && enabled && !signal.aborted && current === generation) timer = setTimeout(refresh, 1000);
    }
  }

  function changed() {
    generation++;
    clearTimeout(timer);
    node.hidden = true;
    if (enabled) void refresh();
  }

  function destroy() {
    if (closed) return;
    closed = true;
    generation++;
    clearTimeout(timer);
    preferences.removeEventListener("change", changed);
    signal.removeEventListener("abort", destroy);
    node.remove();
  }

  preferences.addEventListener("change", changed);
  signal.addEventListener("abort", destroy, { once: true });
  if (!signal.aborted) changed();
  return { element: node, destroy, reset() { collector.reset(); changed(); } };
}
