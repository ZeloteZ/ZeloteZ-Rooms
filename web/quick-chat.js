import { language, locale, t } from "./i18n.js";
import { createQuickChatCrypto, forgetQuickChatDevice } from "./quick-chat-crypto.js";

const messages = {
  connecting: ["Connecting to live chat…", "Livechat wird verbunden …"],
  reconnecting: ["Reconnecting to live chat…", "Livechat wird erneut verbunden …"],
  unavailable: ["Encrypted live chat is unavailable on this device.", "Auf diesem Gerät ist kein verschlüsselter Livechat verfügbar."],
  busy: ["Live chat is busy. Retrying…", "Der Livechat ist ausgelastet. Neuer Versuch …"],
  sendFailed: ["Couldn’t send your message. Try again.", "Deine Nachricht konnte nicht gesendet werden. Versuche es erneut."],
  sendLimited: ["Wait a moment before sending another message.", "Warte kurz, bevor du eine weitere Nachricht sendest."],
};

export function renderQuickChat({ publicId, signal, member = false }) {
  const pane = document.createElement("section");
  pane.className = "panel quick-chat";
  pane.innerHTML = `
    <div class="quick-chat-heading">
      <div class="quick-chat-title">
        <h2></h2>
        <details class="quick-chat-encryption">
          <summary class="tag"></summary>
          <p class="subtle"></p>
        </details>
      </div>
      <details class="quick-chat-roster" open hidden>
        <summary></summary>
        <ul class="quick-chat-participants" role="list" tabindex="0"></ul>
      </details>
    </div>
    <div class="quick-chat-scroll" tabindex="0">
      <p class="subtle quick-chat-empty" hidden></p>
      <ol class="quick-chat-log" role="log" aria-live="polite"></ol>
    </div>
    <p class="status quick-chat-feedback" role="status" hidden></p>
    <form class="quick-chat-form" method="post">
      <input type="text" maxlength="1200" autocomplete="off" disabled>
      <button type="submit" class="button primary" disabled></button>
    </form>`;
  const heading = pane.querySelector("h2");
  const encryption = pane.querySelector(".quick-chat-encryption");
  const roster = pane.querySelector(".quick-chat-roster");
  const rosterSummary = roster.querySelector("summary");
  const rosterList = roster.querySelector("ul");
  const scroll = pane.querySelector(".quick-chat-scroll");
  const empty = pane.querySelector(".quick-chat-empty");
  const log = pane.querySelector("ol");
  const feedback = pane.querySelector(".quick-chat-feedback");
  const form = pane.querySelector("form");
  const input = pane.querySelector("input");
  const send = pane.querySelector("button");
  const endpoint = "/api/guest/" + encodeURIComponent(publicId) + "/chat";

  let connection = "connecting";
  let sendProblem = "";
  let device;
  let peers = [];
  let participants = [];
  let rosterSignature;
  let cursor = 0;
  let joined = false;
  let posting = false;
  let stopped = false;
  let pending;
  let refreshing;
  let timer;

  function update() {
    input.disabled = stopped || peers.length === 0;
    send.disabled = input.disabled || posting || !input.value.trim();
    empty.hidden = Boolean(connection || log.childElementCount);
    const message = messages[sendProblem || connection];
    const label = message ? t(...message) : "";
    feedback.hidden = !label;
    if (feedback.textContent !== label) feedback.textContent = label;
    updateRoster();
  }

  function updateRoster() {
    const signature = JSON.stringify([language(), participants]);
    if (signature === rosterSignature) return;
    rosterSignature = signature;
    roster.hidden = participants.length === 0;
    rosterSummary.textContent = t("Participants ({count})", "Teilnehmende ({count})", { count: participants.length });
    rosterList.setAttribute("aria-label", t("Participants in live chat", "Teilnehmende im Livechat"));
    const names = participants.map(person => person.guest ? guestName(person.name) : person.name);
    names.sort(new Intl.Collator(locale()).compare);
    rosterList.replaceChildren(...names.map(name => {
      const item = document.createElement("li");
      item.textContent = name;
      return item;
    }));
  }

  function timeFormat() {
    return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" });
  }

  function updateLabels() {
    heading.textContent = t("Live chat", "Livechat");
    encryption.querySelector("summary").textContent = t("End-to-end encrypted", "Ende-zu-Ende-verschlüsselt");
    encryption.querySelector("p").textContent = t(
      "Messages are encrypted on the devices of room participants, including guests. This browser can reopen recent messages it received while its room access is valid. A new device can read messages sent after it joins. The server keeps encrypted messages and participant names while the room is open.",
      "Nachrichten werden auf den Geräten der Teilnehmenden verschlüsselt, auch bei Gästen. Solange der Zugang gilt, kann dieser Browser seinen letzten Verlauf wieder öffnen. Ein neues Gerät kann Nachrichten ab seinem Beitritt lesen. Der Server speichert verschlüsselte Nachrichten und Teilnehmernamen, solange der Raum offen ist.");
    pane.setAttribute("aria-label", heading.textContent);
    const logLabel = t("Messages in live chat", "Nachrichten im Livechat");
    scroll.setAttribute("aria-label", logLabel);
    log.setAttribute("aria-label", logLabel);
    empty.textContent = t("No messages yet.", "Noch keine Nachrichten.");
    input.placeholder = t("Write a message", "Nachricht schreiben");
    input.setAttribute("aria-label", t("Message in live chat", "Nachricht im Livechat"));
    send.textContent = t("Send", "Senden");
    const format = timeFormat();
    for (const time of log.querySelectorAll("time")) time.textContent = format.format(new Date(time.dateTime));
    for (const name of log.querySelectorAll("[data-guest-name]")) name.textContent = guestName(name.dataset.guestName);
    update();
  }

  function guestName(name) {
    return t("Guest {name}", "Gast {name}", { name });
  }

  function stop(invalidate = false) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (invalidate) void forgetQuickChatDevice(publicId, member, device?.deviceId);
    else if (device) void request("/leave", { deviceId: device.deviceId }, true).catch(() => {});
    peers = [];
    participants = [];
    device = undefined;
    pending = undefined;
    input.value = "";
    log.replaceChildren();
    update();
    pane.hidden = true;
  }

  async function request(path, body, keepalive = false) {
    const headers = { "Accept-Language": language() };
    if (body) headers["Content-Type"] = "application/json";
    const deadline = AbortSignal.timeout(8000);
    const response = await fetch(endpoint + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      keepalive,
      signal: keepalive ? deadline : AbortSignal.any([signal, deadline]),
    });
    if (!response.ok) throw Object.assign(new Error("Live chat request failed"), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  }

  async function display(batch) {
    const format = timeFormat();
    const rows = await Promise.all(batch.map(async message => {
      try {
        const text = await device.open(message);
        const row = document.createElement("li");
        const byline = document.createElement("div");
        const name = document.createElement("strong");
        const time = document.createElement("time");
        const body = document.createElement("p");
        byline.className = "quick-chat-byline";
        name.textContent = message.guest ? guestName(message.name) : message.name;
        if (message.guest) name.dataset.guestName = message.name;
        time.dateTime = message.sentAt;
        time.textContent = format.format(new Date(time.dateTime));
        body.textContent = text;
        byline.append(name, time);
        row.append(byline, body);
        return row;
      } catch {
        return null;
      }
    }));
    if (stopped) return;
    const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    log.append(...rows.filter(Boolean));
    while (log.childElementCount > 200) log.firstElementChild.remove();
    if (nearEnd) scroll.scrollTop = scroll.scrollHeight;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!stopped && !posting) timer = setTimeout(() => void refresh(), delay);
  }

  function saveStatus(error, fallback) {
    if (stopped) return;
    if ([401, 403, 404, 410].includes(error.status)) stop(true);
    else return error.status === 429 ? "busy" : fallback;
  }

  async function poll() {
    try {
      if (!device) {
        const session = await createQuickChatCrypto(publicId, { member });
        if (stopped) return;
        device = session;
      }
      let batch;
      if (joined) {
        const query = new URLSearchParams({ deviceId: device.deviceId, after: cursor });
        try {
          batch = await request("?" + query);
        } catch (error) {
          if (error.status !== 409 || stopped) throw error;
          joined = false;
        }
      }
      if (!joined) {
        const register = () => request("/join", { deviceId: device.deviceId, publicKey: device.publicKey });
        try {
          batch = await register();
        } catch (error) {
          if (error.status !== 409 || stopped) throw error;
          await forgetQuickChatDevice(publicId, member, device.deviceId);
          const replacement = await createQuickChatCrypto(publicId, { member });
          if (stopped) return;
          device = replacement;
          batch = await register();
        }
      }
      if (stopped) return;
      if (batch.deviceId !== device.deviceId || !batch.peers.some(peer => peer.id === device.deviceId)
        || !Number.isSafeInteger(batch.cursor) || batch.cursor < (joined ? cursor : 0)) throw new Error("Invalid live chat state");
      if (!joined) log.replaceChildren();
      await display(batch.messages);
      if (stopped) return;
      cursor = batch.cursor;
      peers = batch.peers;
      participants = batch.participants ?? peers.map(({ name, guest }) => ({ name, guest }));
      joined = true;
      connection = "";
    } catch (error) {
      peers = [];
      participants = [];
      connection = saveStatus(error, "reconnecting") ?? "";
    }
    update();
  }

  function refresh() {
    if (stopped) return;
    refreshing ??= poll().finally(() => {
      refreshing = undefined;
      schedule(connection ? 4500 : 2000);
    });
    return refreshing;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const draft = input.value;
    if (stopped || posting || !draft.trim() || !peers.length) return;
    posting = true;
    sendProblem = "";
    clearTimeout(timer);
    update();
    if (pending?.draft !== draft) pending = { id: crypto.randomUUID(), draft };
    const { id } = pending;
    let sent = false;

    async function submit() {
      if (stopped || !peers.length) return;
      const { deviceId, seal } = device;
      const envelope = await seal(id, draft, peers);
      if (stopped) return;
      await request("", { deviceId, id, envelope });
      sent = true;
    }

    try {
      await refreshing;
      try {
        await submit();
      } catch (error) {
        if (error.status !== 409 || stopped) throw error;
        await refresh();
        await submit();
      }
      if (sent) {
        if (input.value === draft) input.value = "";
        pending = undefined;
      }
    } catch (error) {
      const nextStatus = saveStatus(error, "sendFailed");
      sendProblem = nextStatus === "busy" ? "sendLimited" : nextStatus;
    } finally {
      posting = false;
      update();
      schedule(sent ? 0 : 2000);
    }
  }, { signal });
  input.addEventListener("input", () => {
    pending = undefined;
    sendProblem = "";
    update();
  }, { signal });
  pane.addEventListener("guest-language", updateLabels, { signal });
  pane.addEventListener("quick-chat-revoke", () => stop(true), { signal });
  signal.addEventListener("abort", () => stop(), { once: true });
  window.addEventListener("pagehide", event => {
    if (!event.persisted) stop();
  }, { signal });
  if (signal.aborted) stop();
  else if (!globalThis.crypto?.subtle || !crypto.randomUUID) connection = "unavailable";
  else void refresh();
  updateLabels();
  return pane;
}
