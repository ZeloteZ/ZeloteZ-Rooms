import { language, t } from "./i18n.js";
import { button, el, notify, topicHref } from "./ui.js";

const streamId = /^[a-f0-9]{32}$/u;

export function createNativeBroadcast(signal, dock) {
  const bridge = window.roomsNativeCapture;
  if (!dock || !bridge?.observe || !bridge?.status) return null;
  const events = new EventTarget();
  let active = null;
  let location;
  let revision = 0;
  let opening = false;
  const link = el("a", { class: "button", hidden: true }, t("Go to live channel", "Zum Live-Kanal"));
  const details = el("details", { class: "stream-dock", name: "header-media" });
  const summary = el("summary", { class: "button" }, t("Live", "Live"));
  const title = el("p", { class: "muted" });
  const stop = () => bridge.close();
  const end = () => button(t("End stream", "Stream beenden"), async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try { await stop(); } catch {
      if (!signal.aborted) notify(t("The stream couldn’t be stopped.", "Der Stream konnte nicht beendet werden."));
    } finally {
      control.disabled = false;
    }
  }, { class: "danger" });
  details.append(summary, el("div", { class: "stream-popover" }, el("section", { class: "panel stack" },
    title, el("div", { class: "inline" }, link, end()))));
  dock.replaceChildren(details);
  dock.hidden = true;
  details.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !details.open) return;
    event.stopPropagation();
    details.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  link.addEventListener("click", () => { details.open = false; }, { signal });

  function placeDock() {
    dock.hidden = !active;
    if (!active) {
      details.open = false;
      return;
    }
    const channel = location?.id === active.channelId ? location : null;
    title.textContent = channel
      ? t("You’re live in {channel}.", "Du streamst in {channel}.", { channel: channel.title })
      : t("Your screen is live.", "Dein Bildschirm ist live.");
    summary.setAttribute("aria-label", title.textContent);
    link.hidden = !channel;
    if (channel) link.href = topicHref(channel.roomId, channel.id);
  }

  function update(value) {
    const previous = active?.streamId;
    active = value && streamId.test(value.streamId) && typeof value.channelId === "string" ? value : null;
    placeDock();
    events.dispatchEvent(new Event("status"));
    if (active?.streamId !== previous) events.dispatchEvent(new Event("change"));
  }

  const removeObservers = bridge.observe(value => {
    ++revision;
    update(value);
  }, (id, bytes) => {
    if (active?.streamId === id && ArrayBuffer.isView(bytes) && !document.hidden) {
      events.dispatchEvent(new CustomEvent("frame", { detail: bytes }));
    }
  });
  const initial = revision;
  bridge.status().then(value => {
    if (!signal.aborted && revision === initial) update(value);
  }).catch(() => {});
  signal.addEventListener("abort", () => {
    removeObservers();
    dock.hidden = true;
    dock.replaceChildren();
  }, { once: true });

  function mount(room, channel, viewSignal) {
    const heading = t("Your stream preview", "Deine Stream-Vorschau");
    const canvas = el("canvas", { hidden: true, role: "img", "aria-label": heading });
    const canvasContext = canvas.getContext("2d", { alpha: false });
    const stage = el("div", { class: "stage native-broadcast-stage" }, canvas);
    const waiting = el("p", { class: "muted native-broadcast-waiting" }, t("Loading preview …", "Vorschau wird geladen …"));
    stage.append(waiting);
    const stats = el("div", { class: "inline native-broadcast-metrics", hidden: true });
    const node = el("section", { class: "native-broadcast stack", hidden: true, "aria-label": heading },
      el("header", { class: "section-heading" },
        el("div", { class: "inline" }, el("span", { class: "tag live" }, "Live"), el("h3", {}, heading)), end()),
      stage, stats);
    let drawing = false;
    let mountedId;
    let caption;
    const number = new Intl.NumberFormat(language(), { maximumFractionDigits: 1 });

    function refresh() {
      const shown = active?.channelId === channel.id;
      node.hidden = !shown;
      const id = shown ? active.streamId : null;
      if (id !== mountedId) {
        mountedId = id;
        canvas.hidden = true;
        waiting.hidden = false;
        stats.hidden = true;
        caption = undefined;
      }
      if (!shown) return;
      if (!location || location.id !== channel.id) {
        location = { roomId: room.id, id: channel.id, title: channel.title };
        placeDock();
      }
      if (!Number.isFinite(active.elapsed)) return;
      const seconds = Math.floor(active.elapsed);
      const duration = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
      const values = [
        duration, `${active.width} × ${active.height}`, `${number.format(active.fps)} FPS`, `${number.format(active.mbps)} Mbit/s`,
      ];
      if (caption !== values.join(" ")) {
        caption = values.join(" ");
        stats.replaceChildren(...values.map(text => el("span", { class: "tag" }, text)));
      }
      stats.hidden = false;
    }

    events.addEventListener("status", refresh, { signal: viewSignal });
    events.addEventListener("frame", async ({ detail }) => {
      if (node.hidden || !node.isConnected || drawing || !canvasContext) return;
      const id = mountedId;
      drawing = true;
      let image;
      try {
        image = await createImageBitmap(new Blob([detail], { type: "image/jpeg" }));
        if (viewSignal.aborted || id !== mountedId || node.hidden) return;
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width;
          canvas.height = image.height;
        }
        canvasContext.drawImage(image, 0, 0);
        waiting.hidden = true;
        canvas.hidden = false;
      } catch {
        // Keep the last complete image if a preview frame cannot be decoded.
      } finally {
        image?.close();
        drawing = false;
      }
    }, { signal: viewSignal });
    refresh();
    return node;
  }

  return {
    open: async (room, channel, lang) => {
      if (opening) return "busy";
      opening = true;
      try {
        const result = await bridge.open(channel.id, lang, true);
        if (result === "opened") {
          location = { roomId: room.id, id: channel.id, title: channel.title };
          placeDock();
        }
        return result;
      } finally {
        opening = false;
      }
    },
    active: () => active,
    whenChanged: (callback, options) => events.addEventListener("change", callback, options),
    mount, stop,
  };
}
