import { createChannelCapture } from "./channel-capture.js";
import { t } from "./i18n.js";
import { api, button, closeDialog, el, identifier, notify, showDialog, status, tell } from "./ui.js";

export function createQuickScreen(context, channel) {
  const { signal, screenShare, nativeBroadcast } = context;
  const endpoint = "channels/" + identifier(channel.id) + "/streams";
  const capture = createChannelCapture(context, channel);
  const optionsLabel = t("Share options", "Freigabeoptionen");
  const unavailable = t("Screen sharing is unavailable in this room.", "Die Bildschirmfreigabe ist in diesem Raum nicht verfügbar.");
  const reconnecting = t("Checking screen sharing again…", "Freigabe wird erneut geprüft …");
  const feedback = status();
  const share = button(t("Share screen", "Bildschirm teilen"), start, { class: "primary", disabled: true });
  const options = capture.options && button(optionsLabel, openOptions, { "aria-haspopup": "dialog", disabled: true });
  const actions = el("div", { class: "inline quick-screen-actions" }, share, options, feedback);
  let canStream = false;
  let occupied = false;
  let opening = false;
  let refreshing = false;
  let requestedFocus = false;
  let timer;

  function render() {
    const capturingHere = screenShare.active()?.channel.id === channel.id || nativeBroadcast?.active()?.channelId === channel.id;
    const capturing = screenShare.active() || nativeBroadcast?.active();
    share.hidden = occupied || capturingHere;
    share.disabled = !canStream || Boolean(capturing) || opening;
    if (options) {
      options.hidden = share.hidden;
      options.disabled = share.disabled;
    }
    if (requestedFocus && !share.hidden && !share.disabled && share.getClientRects().length) {
      requestedFocus = false;
      share.focus({ preventScroll: true });
    }
  }

  function openOptions() {
    if (share.disabled || share.hidden) return;
    showDialog(optionsLabel, el("div", { class: "stack" }, capture.options,
    el("div", { class: "inline" }, button(t("Done", "Fertig"), closeDialog, { class: "primary" }))));
  }

  async function start() {
    if (signal.aborted || share.disabled || share.hidden) return;
    opening = true;
    tell(feedback, "");
    render();
    try {
      await capture.start();
    } catch (error) {
      if (signal.aborted) notify(error.message);
      else tell(feedback, error.message, "error");
    } finally {
      opening = false;
      if (!signal.aborted) captureChanged();
    }
  }

  async function refresh() {
    if (signal.aborted || refreshing) return;
    refreshing = true;
    clearTimeout(timer);
    try {
      const data = await api(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (signal.aborted) return;
      canStream = data?.canStream === true && Array.isArray(data.streams);
      occupied = canStream && data.streams.length > 0;
      if (!canStream) tell(feedback, unavailable, "error");
      else if (feedback.textContent === reconnecting || feedback.textContent === unavailable) tell(feedback, "");
    } catch (error) {
      if (signal.aborted) return;
      canStream = false;
      if (!feedback.textContent || feedback.textContent === unavailable || feedback.textContent === reconnecting) {
        const denied = error.status === 403 || error.status === 404;
        tell(feedback, denied ? unavailable : reconnecting, "error");
      }
    } finally {
      refreshing = false;
      if (!signal.aborted) {
        render();
        timer = setTimeout(refresh, 4000);
      }
    }
  }

  function captureChanged() {
    render();
    void refresh();
  }

  screenShare.whenChanged(captureChanged, { signal });
  nativeBroadcast?.whenChanged(captureChanged, { signal });
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void refresh();
  return { actions, prepare() { requestedFocus = true; render(); } };
}
