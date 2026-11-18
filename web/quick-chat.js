import { language, locale, t } from "./i18n.js";
import { createQuickChatCrypto, forgetQuickChatDevice } from "./quick-chat-crypto.js";
import { foldMessageText, textPrefix } from "./message-overflow.js";
import { button, el } from "./ui.js";

const messages = {
  connecting: ["Connecting to live chat…", "Livechat wird verbunden …"],
  reconnecting: ["Reconnecting to live chat…", "Livechat wird erneut verbunden …"],
  unavailable: ["Encrypted live chat is unavailable on this device.", "Auf diesem Gerät ist kein verschlüsselter Livechat verfügbar."],
  busy: ["Live chat is busy. Retrying…", "Der Livechat ist ausgelastet. Neuer Versuch …"],
  sendFailed: ["Couldn’t send your message. Try again.", "Deine Nachricht konnte nicht gesendet werden. Versuche es erneut."],
  sendLimited: ["Wait a moment before sending another message.", "Warte kurz, bevor du eine weitere Nachricht sendest."],
};

export function renderQuickChat({ publicId, signal, member = false, accountId, onAccountChanged }) {
  if (member && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(accountId ?? "")) {
    throw new Error(t("Your session has changed. Please sign in again.", "Deine Sitzung hat sich geändert. Melde dich erneut an."));
  }
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
  const quotePreview = el("div", { class: "quick-chat-quote-draft", hidden: true });
  form.prepend(quotePreview);
  const endpoint = "/api/guest/" + encodeURIComponent(publicId) + "/chat";
  const displayed = new Map();

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
  let quotedId;

  function update() {
    input.disabled = stopped || peers.length === 0;
    send.disabled = input.disabled || posting || !input.value.trim();
    for (const { quoteAction } of displayed.values()) {
      if (quoteAction) quoteAction.disabled = input.disabled || posting;
    }
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
    for (const record of displayed.values()) {
      if (record.quoteAction) record.quoteAction.textContent = t("Quote", "Zitieren");
    }
    for (const toggle of log.querySelectorAll(".message-text-toggle")) {
      toggle.textContent = toggle.getAttribute("aria-expanded") === "true" ? t("Less", "Weniger") : t("More…", "Mehr …");
    }
    refreshQuotes(true);
    showQuote();
    update();
  }

  function guestName(name) {
    return t("Guest {name}", "Gast {name}", { name });
  }

  function quoteContent(record) {
    const excerpt = textPrefix(record.text, 150, 2);
    return [
      el("strong", {}, record.guest ? guestName(record.name) : record.name),
      el("span", {}, excerpt + (excerpt.length < record.text.length ? "…" : "")),
    ];
  }

  function showQuote() {
    const source = displayed.get(quotedId);
    quotePreview.hidden = !source;
    quotePreview.replaceChildren();
    if (!source) return;
    const remove = t("Remove quote", "Zitat entfernen");
    quotePreview.append(el("blockquote", { class: "quick-chat-quote" }, ...quoteContent(source)),
      button("×", () => { chooseQuote(); input.focus(); },
        { class: "ghost quick-chat-quote-remove", "aria-label": remove, title: remove }));
  }

  function chooseQuote(id) {
    if (quotedId === id) return;
    quotedId = id;
    pending = undefined;
    showQuote();
  }

  function refreshQuotes(force = false) {
    for (const record of displayed.values()) {
      if (!record.quote) continue;
      const source = displayed.get(record.replyTo);
      if (!force && record.quoteSource === source && record.quote.hasChildNodes()) continue;
      record.quoteSource = source;
      if (source) {
        record.quote.replaceChildren(button(quoteContent(source), () => {
          source.row.scrollIntoView({ block: "nearest" });
          source.row.focus({ preventScroll: true });
        }, { class: "ghost quick-chat-quote-link" }));
      } else record.quote.textContent = t("Quoted message is unavailable.", "Die zitierte Nachricht ist nicht verfügbar.");
    }
    if (quotedId && !displayed.has(quotedId)) chooseQuote();
  }

  function clearMessages() {
    displayed.clear();
    log.replaceChildren();
    chooseQuote();
  }

  function stop(invalidate = false) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (invalidate) void forgetQuickChatDevice(publicId, member, device?.deviceId, accountId);
    else if (device) void request("/leave", { deviceId: device.deviceId }, true).catch(() => {});
    peers = [];
    participants = [];
    device = undefined;
    pending = undefined;
    input.value = "";
    clearMessages();
    update();
    pane.hidden = true;
  }

  async function request(path, body, keepalive = false) {
    const headers = { "Accept-Language": language(), ...(member && { "X-Rooms-Account": accountId }) };
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
    if (member && response.headers.get("X-Rooms-Error") === "account-changed") {
      stop(true);
      onAccountChanged?.();
      throw Object.assign(new Error("Account changed"), { status: 409 });
    }
    if (!response.ok) throw Object.assign(new Error("Live chat request failed"), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  }

  async function display(batch) {
    const format = timeFormat();
    const records = await Promise.all(batch.map(async message => {
      try {
        const { text, replyTo } = await device.open(message, { includeReply: true });
        const { id, name, guest, sentAt } = message;
        const author = el("strong", { "data-guest-name": guest ? name : undefined }, guest ? guestName(name) : name);
        const time = el("time", { datetime: sentAt }, format.format(new Date(sentAt)));
        const own = message.own ?? message.from === device.deviceId;
        const quoteAction = !own && button(t("Quote", "Zitieren"), () => {
          if (input.disabled || posting) return;
          chooseQuote(id);
          input.focus();
        }, { class: "ghost quick-chat-quote-action" });
        const quote = replyTo && el("blockquote", { class: "quick-chat-quote" });
        const body = foldMessageText(text, (visible, clipped) => [el("p", {}, visible + (clipped ? "…" : ""))]);
        const row = el("li", { tabindex: -1, "data-message-id": id },
          el("div", { class: "quick-chat-byline" }, author, time, quoteAction), quote, body);
        return { id, name, guest, row, text, replyTo, quote, quoteAction };
      } catch {
        return null;
      }
    }));
    if (stopped || !records.some(Boolean)) return;
    const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    for (const record of records) {
      if (!record || displayed.has(record.id)) continue;
      displayed.set(record.id, record);
      log.append(record.row);
    }
    while (log.childElementCount > 200) {
      const first = log.firstElementChild;
      displayed.delete(first.dataset.messageId);
      first.remove();
    }
    refreshQuotes();
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
        const session = await createQuickChatCrypto(publicId, { member, accountId, signal, async proveLegacy(candidate) {
          const query = new URLSearchParams({ deviceId: candidate.deviceId, after: "0" });
          let batch;
          try { batch = await request("?" + query); } catch (error) {
            if (stopped || signal.aborted) throw error;
            if ([401, 403, 404, 409, 410].includes(error.status)) return false;
            throw error;
          }
          signal.throwIfAborted();
          if (stopped) throw new DOMException("Chat closed", "AbortError");
          const own = batch?.peers?.find(peer => peer.id === candidate.deviceId);
          return batch?.deviceId === candidate.deviceId && own?.publicKey?.x === candidate.publicKey.x &&
            own.publicKey.y === candidate.publicKey.y;
        } });
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
          await forgetQuickChatDevice(publicId, member, device.deviceId, accountId);
          const replacement = await createQuickChatCrypto(publicId, { member, accountId, signal });
          if (stopped) return;
          device = replacement;
          batch = await register();
        }
      }
      if (stopped) return;
      if (batch.deviceId !== device.deviceId || !batch.peers.some(peer => peer.id === device.deviceId)
        || !Number.isSafeInteger(batch.cursor) || batch.cursor < (joined ? cursor : 0)) throw new Error("Invalid live chat state");
      if (!joined) clearMessages();
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
    const replyTo = quotedId;
    posting = true;
    sendProblem = "";
    clearTimeout(timer);
    update();
    if (pending?.draft !== draft || pending.replyTo !== replyTo) pending = { id: crypto.randomUUID(), draft, replyTo };
    const { id } = pending;
    let sent = false;

    async function submit() {
      if (stopped || !peers.length) return;
      const { deviceId, seal } = device;
      const envelope = await seal(id, draft, peers, replyTo);
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
        if (quotedId === replyTo) chooseQuote();
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
