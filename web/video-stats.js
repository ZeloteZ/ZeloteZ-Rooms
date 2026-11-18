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

export function mountVideoStats(collector, signal, { sending = false } = {}) {
  const active = () => sending || enabled;
  const node = el("div", { class: "video-reception-stats", role: "group", hidden: true,
    "aria-label": sending ? t("Video transmission statistics", "Video-Sendedaten")
      : t("Video reception statistics", "Video-Empfangsdaten") });
  const elapsed = el("span", { title: sending ? t("Stream duration", "Streamdauer") : t("Viewing time", "Wiedergabedauer") });
  const resolution = el("span", { title: sending ? t("Sent resolution", "Gesendete Auflösung") : t("Received resolution", "Empfangene Auflösung") });
  const frames = el("span", { title: sending ? t("Sent frame rate", "Gesendete Bildrate") : t("Received frame rate", "Empfangene Bildrate") });
  const rate = el("span", { title: sending ? t("Sent video data", "Gesendete Videodaten") : t("Received video data", "Empfangene Videodaten") });
  const path = sending ? t("Connection to the streaming server", "Verbindung zum Streaming-Server") : "";
  const loss = el("span", { title: path });
  const jitter = el("span", { title: path });
  const dropped = el("span");
  const codec = el("span");
  node.append(elapsed, resolution, frames, rate, loss, jitter, dropped, codec);
  let timer;
  let generation = 0;
  let closed = false;

  async function refresh() {
    const current = generation;
    if (closed || !active() || signal.aborted) return;
    try {
      const data = await collector.sample();
      if (closed || !active() || signal.aborted || current !== generation) return;
      const format = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
      const rateFormat = new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 });
      const lossFormat = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 });
      const countFormat = new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 });
      const measured = (value, formatter, unit = "") => Number.isFinite(value) && value >= 0
        ? formatter.format(value) + unit : "—";
      const seconds = Math.max(0, Math.floor(data.elapsed ?? 0));
      elapsed.textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
      resolution.textContent = data.width > 0 && data.height > 0 ? data.width + " × " + data.height : "—";
      frames.textContent = (Number.isFinite(data.fps) ? format.format(data.fps) : "—") + " FPS";
      rate.textContent = (Number.isFinite(data.mbps) ? rateFormat.format(data.mbps) : "—") + " Mbit/s";
      loss.textContent = t("Packet loss", "Paketverlust") + ": " + measured(data.packetLoss, lossFormat, " %");
      jitter.textContent = t("Jitter", "Jitter") + ": " + measured(data.jitterMs, format, " ms");
      dropped.textContent = t("Frames dropped", "Verworfene Frames") + ": " + measured(data.framesDropped, countFormat);
      codec.textContent = t("Codec", "Codec") + ": " + (data.codec || "—");
      node.hidden = !(data.width > 0 && data.height > 0);
    } catch {
      if (current === generation) node.hidden = true;
    } finally {
      if (!closed && active() && !signal.aborted && current === generation) timer = setTimeout(refresh, 1000);
    }
  }

  function changed() {
    generation++;
    clearTimeout(timer);
    node.hidden = true;
    if (active()) void refresh();
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
  return { element: node, destroy, reset() { collector.reset?.(); changed(); } };
}

export function mountSendingStats(screenShare, nativeBroadcast, channel, signal) {
  return mountVideoStats({
    async sample() {
      const native = nativeBroadcast?.active();
      if (native && String(native.channelId) === String(channel.id)) return native;
      const entry = screenShare?.active();
      if (entry?.phase !== "live" || String(entry.channel.id) !== String(channel.id) || !entry.stats) return {};
      const data = await entry.stats.sample();
      return screenShare.active() === entry ? data : {};
    },
  }, signal, { sending: true });
}
