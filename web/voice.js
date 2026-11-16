import { api, button, el, identifier, notify, personMark, personName, sameId, status, tell, topicHref } from "./ui.js";
import { t } from "./i18n.js";

const heartbeatDelay = 5000;
const peerId = /^[0-9a-f]{32}$/u;
const supported = () => typeof RTCPeerConnection === "function";
const releasedPeers = new Map();
let releaseCurrentVoice;

function forgetExpiredReleases() {
  const now = Date.now();
  for (const [id, release] of releasedPeers) if (release.until <= now) releasedPeers.delete(id);
}

export function wasVoiceReleased(id) {
  forgetExpiredReleases();
  return releasedPeers.has(id);
}

export function releaseVoiceForLogout() {
  return releaseCurrentVoice?.();
}

function waitForIce(peer, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", change);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const change = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error(t("The audio connection timed out.", "Die Audioverbindung braucht zu lange."))), 10000);
    peer.addEventListener("icegatheringstatechange", change);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else change();
  });
}

function mediaError(error, microphone) {
  if (error.name === "NotAllowedError" && microphone) return t("The browser denied microphone access.", "Der Browser hat den Mikrofonzugriff verweigert.");
  if (error.name === "NotFoundError" && microphone) return t("No microphone was found.", "Es wurde kein Mikrofon gefunden.");
  if (error.name === "NotReadableError" && microphone) return t("The microphone is currently unavailable.", "Das Mikrofon ist gerade nicht verfügbar.");
  return microphone ? t("The microphone could not be connected.", "Das Mikrofon konnte nicht verbunden werden.") : t("Reconnecting audio.", "Die Audioverbindung wird erneut aufgebaut.");
}

function closeEndpoint(endpoint) {
  if (!endpoint) return;
  return fetch("/api/" + endpoint, {
    method: "DELETE", keepalive: true, signal: AbortSignal.timeout(2500),
    credentials: "same-origin", referrer: location.origin + "/", referrerPolicy: "same-origin",
    cache: "no-store", redirect: "error",
  }).catch(() => {});
}

async function negotiate(peer, base, route, signal, saveResource) {
  await peer.setLocalDescription(await peer.createOffer());
  await waitForIce(peer, signal);
  const response = await fetch("/api/" + base + "/" + route, {
    method: "POST", headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
    body: peer.localDescription.sdp, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    credentials: "same-origin", referrer: location.origin + "/", referrerPolicy: "same-origin",
    cache: "no-store", redirect: "error",
  });
  if (response.status !== 201) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || t("The voice server is unavailable right now.", "Der Sprachserver ist gerade nicht erreichbar."));
  }
  const resource = response.headers.get("Location");
  const prefix = "/api/" + base + "/sessions/";
  const resourceId = resource?.startsWith(prefix) ? resource.slice(prefix.length) : null;
  if (!resourceId || !peerId.test(resourceId)) throw new Error(t("The audio connection is invalid.", "Die Audioverbindung ist ungültig."));
  saveResource(resource.slice(5), response.headers.get("X-Voice-Media-Version"));
  signal.throwIfAborted();
  await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
}

function dispose(entry, removeResource = true) {
  if (!entry || entry.closed) return;
  entry.closed = true;
  entry.controller.abort();
  clearTimeout(entry.connectTimer);
  entry.peer?.close();
  for (const track of entry.input?.getTracks() ?? []) track.stop();
  if (entry.audio) {
    entry.audio.pause();
    entry.audio.srcObject = null;
    entry.audio.remove();
  }
  if (removeResource) closeEndpoint(entry.resource);
}

function observePeer(entry, failure, onChange = () => {}) {
  const peer = entry.peer;
  entry.connectTimer = setTimeout(failure, 19000);
  peer.addEventListener("connectionstatechange", () => {
    if (entry.closed) return;
    entry.connected = peer.connectionState === "connected";
    if (entry.connected) clearTimeout(entry.connectTimer);
    else if (["failed", "closed"].includes(peer.connectionState)) failure();
    else if (peer.connectionState === "disconnected") {
      clearTimeout(entry.connectTimer);
      entry.connectTimer = setTimeout(failure, 8000);
    }
    onChange();
  });
}

export function createVoicePanel(context, dock) {
  const { signal } = context;
  const interruptedNote = t("The voice connection was interrupted.", "Die Verbindung zum Sprachchat ist unterbrochen.");
  const sink = el("div", { hidden: true });
  const dockIcon = el("span", { class: "voice-dock-icon", "aria-hidden": "true" },
    el("i"), el("i"), el("i"));
  const dockLabel = el("span", { class: "voice-dock-label", "aria-hidden": "true" });
  const dockState = el("span", { class: "voice-dock-state", "aria-hidden": "true" });
  const dockSummary = el("summary", { class: "voice-dock-summary" }, dockIcon, dockLabel, dockState);
  const returnLink = el("a", { class: "voice-place" });
  const inline = createControls();
  const compact = createControls(returnLink);
  compact.node.dataset.mode = "compact";
  const details = el("details", { class: "voice-dock-details", name: "header-media" }, dockSummary,
    el("div", { class: "voice-dock-popover" }, compact.node));
  dock.replaceChildren(details, sink);
  let current;
  let active;

  function createControls(place) {
    const presence = el("span", { class: "tag voice-presence", hidden: true });
    const roster = el("ul", { class: "voice-roster", "aria-label": t("Voice chat participants", "Teilnehmende im Sprachchat"), hidden: true });
    const note = status();
    const join = button(t("Join voice chat", "Sprachchat betreten"), () => {
      const destination = place ? active : current;
      const replacement = sameId(destination?.channel.id, active?.channel.id) ? active?.conflictingPeerId : undefined;
      connect(destination, replacement);
    }, { class: "primary" });
    const leave = button(t("Leave", "Verlassen"), () => disconnect(), { "aria-label": t("Leave voice chat", "Sprachchat verlassen") });
    const mic = button(t("Turn on microphone", "Mikrofon einschalten"), toggleMic);
    const micOff = button(t("Turn off microphone", "Mikrofon aus"), () => stopMicrophone(active));
    const audioOn = button(t("Enable audio playback", "Ton abspielen"), activateAudio, { class: "primary", hidden: true });
    const node = el("section", { class: "panel voice-panel", "aria-label": t("Voice chat", "Sprachchat") },
      el("div", { class: "voice-heading" }, el("div", {}, el("h2", {}, t("Voice chat", "Sprachchat")), place), presence),
      roster, note, el("div", { class: "voice-actions" }, join, mic, micOff, audioOn, leave));
    return { node, presence, roster, note, join, leave, mic, micOff, audioOn };
  }

  function render() {
    const listening = Boolean(active?.confirmed);
    const sender = active?.sender;
    const speaking = Boolean(sender?.connected && sender.track.enabled);
    const presenceText = speaking ? t("Microphone on", "Mikrofon an") : sender?.connected ? t("Muted", "Stumm") : sender ? t("Connecting", "Verbinden") : t("Listening", "Zuhören");
    dock.hidden = !active || Boolean(active.joinError && !active.self);
    if (active) {
      const place = active.topic.title + " · " + active.channel.title;
      const voiceStatus = listening ? presenceText : active.joinError ? t("Connection failed", "Verbindung fehlgeschlagen") : t("Connecting", "Verbinden");
      dockLabel.textContent = active.channel.title;
      dockState.textContent = voiceStatus;
      dockSummary.setAttribute("aria-label", t("Voice chat · {place} · {status}", "Sprachchat · {place} · {status}",
        { place, status: voiceStatus }));
      dockSummary.title = place + " · " + voiceStatus;
      dockIcon.dataset.state = speaking ? "speaking" : listening ? "listening" : "connecting";
      returnLink.href = topicHref(active.topic.id, active.channel.id);
      returnLink.textContent = place;
    }
    if (dock.hidden) details.open = false;
    const switchRoom = Boolean(current && active && !sameId(current.channel.id, active.channel.id));
    renderControls(inline, listening, sender, speaking, presenceText, switchRoom);
    renderControls(compact, listening, sender, speaking, presenceText);
  }

  function renderControls({ join, leave, mic, micOff, audioOn, presence, roster, note }, listening, sender, speaking, presenceText, switchRoom = false) {
    join.hidden = Boolean(active) && !active.joinError && !switchRoom;
    join.disabled = !supported();
    join.textContent = switchRoom ? t("Switch voice chat", "Sprachchat wechseln") : active?.conflictingPeerId ? t("Move voice chat here", "Sprachchat hier übernehmen") : t("Join voice chat", "Sprachchat betreten");
    leave.hidden = !active || switchRoom || Boolean(active.joinError && !active.self);
    mic.hidden = !listening || switchRoom;
    mic.disabled = Boolean(active?.requestingMic);
    mic.textContent = sender ? sender.track.enabled ? t("Mute", "Stummschalten") : t("Unmute", "Stummschaltung aufheben") : t("Turn on microphone", "Mikrofon einschalten");
    micOff.hidden = !sender || switchRoom;
    audioOn.hidden = !active?.audioBlocked || switchRoom;
    presence.hidden = !listening || switchRoom;
    presence.textContent = presenceText;
    presence.classList.toggle("voice-speaking", speaking);

    const members = active?.members ?? [];
    const signature = JSON.stringify([active?.self?.id, members]);
    if (signature !== roster.dataset.signature) {
      roster.dataset.signature = signature;
      roster.replaceChildren(...members.map(member => {
        const person = { ...member, id: member.userId };
        const own = sameId(member.id, active?.self?.id);
        return el("li", { class: "voice-person" }, personMark(person),
          el("span", { class: "voice-name" }, personName(person), own ? t(" (you)", " (du)") : ""),
          member.publishing && el("span", { class: "voice-mic-mark", "aria-label": t("Publishing audio", "Sendet Audio"), title: t("Publishing audio", "Sendet Audio") }, "◉"));
      }));
    }
    roster.hidden = !members.length || switchRoom;

    const message = switchRoom ? t("You are still in the voice chat in “{channel}”.", "Dein Talk in „{channel}“ läuft weiter.",
      { channel: active.channel.title }) : active?.feedback ||
      (active?.receiverFailures?.size ? t("Reconnecting an audio track…", "Eine Tonspur wird neu verbunden …") :
      active && !listening ? t("Connecting to voice chat…", "Sprachchat wird verbunden …") :
      !active && !supported() ? t("Voice chat is not available in this browser.", "Sprachchat ist in diesem Browser nicht verfügbar.") : "");
    const kind = !switchRoom && active?.feedbackError ? "error" : "";
    if (message !== note.textContent || note.className !== "status " + kind) tell(note, message, kind);
  }

  function feedback(room, message, error = false) {
    if (active !== room) return;
    room.feedback = message;
    room.feedbackError = error;
    render();
  }

  function streamBase(room) {
    return room.endpoint + "/" + room.self.id;
  }

  function dropReceiver(room, id, removeResource = true) {
    dispose(room.receivers.get(id), removeResource);
    room.receivers.delete(id);
  }

  function stopMicrophone(room, removeResource = true) {
    if (!room?.sender) return;
    dispose(room.sender, removeResource);
    room.sender = null;
    if (active === room) render();
  }

  function disconnect() {
    let release;
    if (active) {
      const room = active;
      active = null;
      room.controller.abort();
      clearTimeout(room.timer);
      if (room.self) {
        forgetExpiredReleases();
        releasedPeers.set(room.self.id, { userId: context.user?.id, until: Date.now() + 45000 });
        release = closeEndpoint(streamBase(room));
      }
      // The peer DELETE also closes every transport, so send it ahead of unload by itself.
      stopMicrophone(room, false);
      for (const id of room.receivers.keys()) dropReceiver(room, id, false);
    }
    render();
    return release;
  }

  function activateAudio() {
    const room = active;
    if (!room) return;
    room.audioBlocked = false;
    render();
    for (const entry of room.receivers.values()) playAudio(room, entry);
  }

  function playAudio(room, entry) {
    if (!entry.audio.srcObject || entry.closed) return;
    entry.audio.play().catch(error => {
      if (error.name === "NotAllowedError" && active === room && !entry.closed) {
        room.audioBlocked = true;
        render();
      }
    });
  }

  async function receive(room, member) {
    const entry = { controller: new AbortController(), audio: el("audio", { autoplay: true }), version: member.mediaVersion };
    room.receivers.set(member.id, entry);
    sink.append(entry.audio);
    const stopped = () => {
      if (entry.closed || active !== room) return;
      dropReceiver(room, member.id);
      room.receiverFailures.add(member.id);
      render();
      // The publishing row can appear just before the upstream audio track becomes ready.
      // Retry on the next heartbeat without interrupting other speakers.
    };
    try {
      entry.peer = new RTCPeerConnection({ iceServers: room.iceServers });
      entry.peer.addTransceiver("audio", { direction: "recvonly" });
      entry.peer.addEventListener("track", event => {
        if (entry.closed || event.track.kind !== "audio") return;
        entry.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        playAudio(room, entry);
      });
      observePeer(entry, stopped, () => {
        if (entry.connected && room.receiverFailures.delete(member.id)) render();
      });
      const requestSignal = AbortSignal.any([room.controller.signal, entry.controller.signal]);
      await negotiate(entry.peer, streamBase(room), "listen/" + member.id, requestSignal, (resource, mediaVersion) => {
        if (entry.closed) closeEndpoint(resource);
        else {
          entry.resource = resource;
          if (peerId.test(mediaVersion)) entry.version = mediaVersion;
        }
      });
    } catch {
      stopped();
    }
  }

  function sync(room, data) {
    room.self = data.self;
    room.confirmed = true;
    room.members = data.members;
    room.lastConfirmed = Date.now();
    const wanted = new Map(data.members.filter(member => member.publishing && peerId.test(member.id) && !sameId(member.id, data.self.id))
      .map(member => [member.id, member]));
    for (const id of room.receiverFailures) if (!wanted.has(id)) room.receiverFailures.delete(id);
    for (const [id, receiver] of room.receivers) {
      if (!wanted.has(id) || receiver.version !== wanted.get(id).mediaVersion) dropReceiver(room, id);
    }
    for (const [id, member] of wanted) if (!room.receivers.has(id)) receive(room, member);
    render();
  }

  async function heartbeat(room) {
    if (active !== room) return;
    try {
      const result = await api(room.endpoint + "/heartbeat", {
        method: "POST", body: { peerId: room.self.id },
        signal: AbortSignal.any([room.controller.signal, AbortSignal.timeout(6000)]),
      });
      if (active !== room) return;
      if (room.feedback === interruptedNote) feedback(room, "");
      sync(room, result);
    } catch (error) {
      if (active !== room) return;
      if ([401, 403, 404, 410].includes(error.status) || Date.now() - room.lastConfirmed > 20000) {
        disconnect();
        if (current && sameId(current.channel.id, room.channel.id)) {
          active = { channel: current.channel, topic: current.topic, controller: new AbortController(), receivers: new Map(), joinError: true };
          feedback(active, error.status === 410 ? t("Your connection ended. You can rejoin the voice chat.", "Deine Verbindung wurde beendet. Du kannst dem Sprachchat erneut beitreten.") :
            t("The voice chat connection has ended.", "Die Verbindung zum Sprachchat wurde beendet."), true);
        } else notify(t("The voice chat connection has ended.", "Die Verbindung zum Sprachchat wurde beendet."));
        return;
      }
      feedback(room, interruptedNote, true);
    }
    if (active === room) room.timer = setTimeout(() => heartbeat(room), heartbeatDelay);
  }

  async function connect(selection, confirmedReplacement) {
    const { channel, topic } = selection ?? {};
    if (signal.aborted || channel?.type !== "live" || !supported()) return;
    const sameChannel = sameId(active?.channel.id, channel.id);
    if (sameChannel && !active.joinError) return;
    const retry = sameChannel && active.attemptId && !confirmedReplacement ? active : null;
    if (!retry) disconnect();
    forgetExpiredReleases();
    const previous = [...releasedPeers].findLast(([, entry]) => entry.userId === context.user?.id)?.[0];
    const room = retry ?? {
      channel, topic, attemptId: crypto.randomUUID().replaceAll("-", ""), replacePeerId: confirmedReplacement ?? previous,
      endpoint: "channels/" + identifier(channel.id) + "/voice", controller: new AbortController(),
      receivers: new Map(), receiverFailures: new Set(),
    };
    room.joinError = false;
    room.conflictingPeerId = null;
    room.feedback = "";
    room.feedbackError = false;
    active = room;
    render();
    try {
      const data = await api(room.endpoint + "/join", {
        method: "POST", body: { attemptId: room.attemptId, replacePeerId: room.replacePeerId },
        signal: AbortSignal.any([room.controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!peerId.test(data.self?.id)) throw new Error(t("Could not join voice chat.", "Sprachchat konnte nicht betreten werden."));
      room.self = data.self;
      if (active !== room) {
        closeEndpoint(streamBase(room));
        return;
      }
      const confirmed = await api(room.endpoint + "/heartbeat", {
        method: "POST", body: { peerId: room.self.id },
        signal: AbortSignal.any([room.controller.signal, AbortSignal.timeout(6000)]),
      });
      if (active !== room) {
        closeEndpoint(streamBase(room));
        return;
      }
      room.iceServers = confirmed.iceServers ?? [];
      sync(room, confirmed);
      room.timer = setTimeout(() => heartbeat(room), heartbeatDelay);
    } catch (error) {
      if (active === room) {
        room.joinError = true;
        if (error.status === 409 && peerId.test(error.details?.activePeerId)) {
          room.conflictingPeerId = error.details.activePeerId;
          room.self = null;
        }
        feedback(room, error.message, true);
      }
    }
  }

  async function toggleMic() {
    const room = active;
    if (!room?.confirmed || room.requestingMic) return;
    if (room.sender) {
      room.sender.track.enabled = !room.sender.track.enabled;
      render();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      feedback(room, t("This browser cannot share a microphone here.", "Dieser Browser kann hier kein Mikrofon freigeben."), true);
      return;
    }
    room.requestingMic = true;
    feedback(room, t("Connecting to the microphone…", "Mikrofon wird verbunden …"));
    let entry;
    try {
      const input = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      if (active !== room) {
        for (const track of input.getTracks()) track.stop();
        return;
      }
      const [track] = input.getAudioTracks();
      entry = { controller: new AbortController(), track, input };
      room.sender = entry;
      if (!track) throw new Error(t("No audio track is available.", "Kein Audiotrack verfügbar."));
      entry.peer = new RTCPeerConnection({ iceServers: room.iceServers });
      entry.peer.addTransceiver(track, { direction: "sendonly", streams: [input] });
      track.addEventListener("ended", () => {
        if (entry.closed || room.sender !== entry) return;
        stopMicrophone(room);
        feedback(room, t("Microphone access has ended.", "Der Mikrofonzugriff wurde beendet."), true);
      }, { once: true });
      const failed = () => {
        if (entry.closed || room.sender !== entry) return;
        stopMicrophone(room);
        feedback(room, t("The microphone connection was interrupted.", "Die Mikrofonverbindung wurde unterbrochen."), true);
      };
      observePeer(entry, failed, () => { if (active === room) render(); });
      const requestSignal = AbortSignal.any([room.controller.signal, entry.controller.signal]);
      await negotiate(entry.peer, streamBase(room), "publish", requestSignal, resource => {
        if (entry.closed) closeEndpoint(resource);
        else entry.resource = resource;
      });
      feedback(room, "");
    } catch (error) {
      if (active === room && (!entry || !entry.closed)) {
        stopMicrophone(room);
        feedback(room, mediaError(error, true), true);
      }
    } finally {
      room.requestingMic = false;
      if (active === room) render();
    }
  }

  if (!signal.aborted) {
    releaseCurrentVoice = disconnect;
    window.addEventListener("pagehide", disconnect, { signal });
    returnLink.addEventListener("click", () => { details.open = false; }, { signal });
    document.addEventListener("pointerdown", event => {
      if (details.open && !dock.contains(event.target)) details.open = false;
    }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && details.open && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
        details.open = false;
        if (dock.contains(document.activeElement)) dockSummary.focus();
      }
    }, { signal });
    signal.addEventListener("abort", () => {
      if (releaseCurrentVoice === disconnect) releaseCurrentVoice = undefined;
      disconnect();
      dock.replaceChildren();
    }, { once: true });
  }
  render();
  return { setLocation(channel, topic, mount) {
    current = mount && channel?.type === "live" ? { channel, topic } : null;
    details.open = false;
    if (current) {
      mount.replaceChildren(inline.node);
      if (!active || (active.joinError && !sameId(active.channel.id, channel.id))) {
        connect(current);
        return;
      }
      if (sameId(active.channel.id, channel.id)) {
        active.channel = channel;
        active.topic = topic;
      }
    } else {
      inline.node.remove();
    }
    render();
  } };
}
