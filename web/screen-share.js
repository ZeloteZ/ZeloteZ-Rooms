import { api, button, el, identifier, notify, topicHref } from "./ui.js";
import { language, t } from "./i18n.js";

const streamId = /^[a-f0-9]{32}$/u;

function allowedCodec(kind, codec) {
  if (kind === "audio") {
    return codec.mimeType.toLowerCase() === "audio/opus" && codec.clockRate === 48000 && codec.channels === 2;
  }
  return codec.mimeType.toLowerCase() === "video/h264" && codec.clockRate === 90000
    && /(?:^|;)\s*packetization-mode=1(?:;|$)/u.test(codec.sdpFmtpLine ?? "");
}

function peerState(peer, event, ready, signal, timeout, errorText) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      peer.removeEventListener(event, check);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => new Error(errorText);
    const check = () => {
      if (ready()) finish();
      else if (["failed", "closed"].includes(peer.connectionState)) finish(failed());
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(failed()), timeout);
    peer.addEventListener(event, check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

function requestWhip(path, method, options = {}) {
  const { body, signal, timeout = 6000 } = options;
  const deadline = AbortSignal.timeout(timeout);
  return fetch(path, {
    method, body, credentials: "same-origin", cache: "no-store", redirect: "error",
    referrer: location.origin + "/", referrerPolicy: "same-origin",
    headers: {
      "Accept-Language": language(),
      ...(body === undefined ? {} : { "Content-Type": "application/sdp", Accept: "application/sdp" }),
    },
    keepalive: method === "DELETE",
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
}

async function captureDisplay(withAudio) {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getDisplayMedia || typeof RTCPeerConnection !== "function") {
    throw new Error(t("Screen sharing is unavailable in this browser.", "Die Bildschirmfreigabe ist in diesem Browser nicht verfügbar."));
  }
  try {
    return await devices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: withAudio,
      systemAudio: "exclude",
      windowAudio: "window",
    });
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      throw new Error(t("Screen sharing was cancelled or denied.", "Die Bildschirmfreigabe wurde abgebrochen oder abgelehnt."));
    }
    throw new Error(t("The browser couldn’t capture the selected screen, window or tab.", "Der Browser konnte den gewählten Bildschirm, das Fenster oder den Tab nicht aufnehmen."));
  }
}

export function createScreenShareController({ signal }, dock) {
  const events = new EventTarget();
  let sharing = null;
  const label = el("span");
  const summary = el("summary", { class: "button" }, label);
  const caption = el("p", { class: "muted", role: "status" });
  const back = el("a", { class: "button" }, t("Go to live channel", "Zum Live-Channel"));
  const finish = button(t("Stop sharing", "Freigabe beenden"), () => stop(), { class: "danger" });
  const details = el("details", { class: "stream-dock", name: "header-media" }, summary,
    el("div", { class: "stream-popover" }, el("section", { class: "panel stack" },
      caption, el("div", { class: "inline" }, back, finish))));
  if (dock) {
    dock.replaceChildren(details);
    dock.hidden = true;
  }
  details.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !details.open) return;
    event.stopPropagation();
    details.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  back.addEventListener("click", () => { details.open = false; }, { signal });

  function update() {
    if (dock) dock.hidden = !sharing;
    if (sharing) {
      const live = sharing.phase === "live";
      label.textContent = live ? t("Sharing", "Freigabe") : t("Starting…", "Startet …");
      const title = live
        ? t("Sharing screen · {channel}", "Bildschirmfreigabe · {channel}", { channel: sharing.channel.title })
        : t("Starting screen sharing · {channel}", "Bildschirmfreigabe startet · {channel}", { channel: sharing.channel.title });
      summary.setAttribute("aria-label", title);
      summary.title = title;
      caption.textContent = title;
      back.href = topicHref(sharing.room.id, sharing.channel.id);
    } else details.open = false;
    events.dispatchEvent(new Event("change"));
  }

  function release(entry) {
    if (!entry.path || entry.released) return;
    entry.released = true;
    requestWhip(entry.path, "DELETE").catch(() => {});
  }

  function stop(message) {
    const entry = sharing;
    if (!entry) return;
    sharing = null;
    entry.controller.abort();
    clearTimeout(entry.heartbeat);
    clearTimeout(entry.disconnectTimer);
    entry.peer?.close();
    for (const track of entry.media?.getTracks() ?? []) track.stop();
    release(entry);
    update();
    if (message && !signal.aborted) notify(message);
  }

  function maintain(entry) {
    const { peer, controller } = entry;
    const disconnected = t("Screen sharing ended because the connection was lost.", "Die Bildschirmfreigabe wurde wegen eines Verbindungsabbruchs beendet.");
    function connectionChanged() {
      if (sharing !== entry) return;
      clearTimeout(entry.disconnectTimer);
      if (["failed", "closed"].includes(peer.connectionState)) stop(disconnected);
      else if (peer.connectionState === "disconnected") {
        entry.disconnectTimer = setTimeout(() => stop(disconnected), 10000);
      }
    }
    async function heartbeat() {
      try {
        const response = await requestWhip(entry.path, "PATCH", { signal: controller.signal });
        if (sharing === entry && [401, 403, 404, 410].includes(response.status)) {
          stop(t("The broadcast is no longer available.", "Die Übertragung ist nicht mehr verfügbar."));
        }
      } catch {
        // A brief HTTP interruption need not interrupt a connected WebRTC peer.
      }
      if (sharing === entry) entry.heartbeat = setTimeout(heartbeat, 12000);
    }
    peer.addEventListener("connectionstatechange", connectionChanged, { signal: controller.signal });
    connectionChanged();
    if (sharing === entry) entry.heartbeat = setTimeout(heartbeat, 12000);
  }

  async function start(room, channel, withAudio) {
    if (signal.aborted || sharing) return;
    const controller = new AbortController();
    const entry = { controller, room, channel, phase: "choosing" };
    sharing = entry;
    update();
    try {
      const media = await captureDisplay(withAudio);
      if (controller.signal.aborted) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      entry.media = media;
      const video = media.getVideoTracks()[0];
      if (!video || video.readyState !== "live") {
        throw new Error(t("The selected screen source ended.", "Die ausgewählte Bildschirmquelle wurde beendet."));
      }
      video.contentHint = "detail";
      const displaySurface = video.getSettings().displaySurface;
      const audio = withAudio && ["browser", "window"].includes(displaySurface) ? media.getAudioTracks()[0] : null;
      const capabilities = new Map();
      for (const track of [video, audio].filter(Boolean)) {
        const codecs = globalThis.RTCRtpSender?.getCapabilities?.(track.kind)?.codecs;
        if (codecs) capabilities.set(track.kind, codecs.filter(codec => allowedCodec(track.kind, codec)));
      }
      if (capabilities.get("video")?.length === 0) {
        throw new Error(t("This browser can’t encode H.264 for live video.", "Dieser Browser kann Live-Video nicht als H.264 übertragen."));
      }
      const audioTrack = capabilities.get("audio")?.length === 0 ? null : audio;
      for (const track of media.getTracks()) {
        if (track !== video && track !== audioTrack) {
          track.stop();
          media.removeTrack(track);
        }
      }
      video.addEventListener("ended", () => {
        if (sharing === entry) stop(t("Screen sharing ended.", "Die Bildschirmfreigabe wurde beendet."));
      }, { once: true, signal: controller.signal });
      entry.phase = "connecting";
      update();
      // Keep the reservation response alive during cancel so its ID can still be released.
      const reservation = await api("channels/" + identifier(channel.id) + "/streams", {
        method: "POST", body: { mode: "browser" }, signal: AbortSignal.timeout(10000),
      });
      const path = streamId.test(reservation.stream?.id) ? "/api/streams/" + reservation.stream.id + "/whip" : null;
      entry.path = path;
      if (controller.signal.aborted) {
        release(entry);
        return;
      }
      if (!path || reservation.whipUrl !== path) {
        throw new Error(t("The server returned an invalid stream destination.", "Der Server hat ein ungültiges Stream-Ziel geliefert."));
      }
      entry.id = reservation.stream.id;
      const peer = new RTCPeerConnection({ iceServers: reservation.iceServers ?? [], bundlePolicy: "max-bundle" });
      entry.peer = peer;
      for (const track of media.getTracks()) {
        const transceiver = peer.addTransceiver(track, { direction: "sendonly", streams: [media] });
        const codecs = capabilities.get(track.kind);
        if (codecs?.length && transceiver.setCodecPreferences) transceiver.setCodecPreferences(codecs);
      }
      await peer.setLocalDescription(await peer.createOffer());
      await peerState(peer, "icegatheringstatechange", () => peer.iceGatheringState === "complete",
        controller.signal, 10000, t("Preparing the WebRTC connection timed out.", "Der Aufbau der WebRTC-Verbindung dauert zu lange."));
      const response = await requestWhip(path, "POST", {
        body: peer.localDescription.sdp, signal: controller.signal, timeout: 12000,
      });
      if (response.status !== 201) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || t("The server couldn’t start the broadcast.", "Der Server konnte die Übertragung nicht starten."));
      }
      if (response.headers.get("Location") !== path) {
        throw new Error(t("The server returned an invalid stream session.", "Der Server hat eine ungültige Stream-Sitzung geliefert."));
      }
      controller.signal.throwIfAborted();
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      await peerState(peer, "connectionstatechange", () => peer.connectionState === "connected",
        controller.signal, 16000, t("Connecting to the streaming server timed out.", "Die Verbindung zum Streamingserver hat zu lange gedauert."));
      controller.signal.throwIfAborted();
      entry.phase = "live";
      update();
      maintain(entry);
    } catch (error) {
      if (sharing !== entry) return;
      stop();
      if (error.name === "TimeoutError") {
        throw new Error(t("The streaming server took too long to respond.", "Der Streamingserver hat zu lange gebraucht."));
      }
      throw error;
    }
  }

  signal.addEventListener("abort", () => stop(), { once: true });
  window.addEventListener("pagehide", () => stop(), { signal });
  return {
    start, stop,
    active: () => sharing,
    whenChanged: (callback, options) => events.addEventListener("change", callback, options),
  };
}
