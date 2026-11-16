import { api, button, closeDialog, el, field, form, localizedTime, personName, showDialog, status, tell } from "./ui.js";
import { t } from "./i18n.js";
import { createMentionDirectory, mentionComposer, renderMentionText } from "./mentions.js";
import { createReactions } from "./reactions.js";

export function renderStreamChat({ signal, messageId, user }, streamId) {
  const endpoint = "streams/" + streamId + "/chat";
  const log = el("ol", { class: "stream-chat-log", "aria-label": t("Messages in stream chat", "Nachrichten im Streamchat"), "aria-live": "polite" });
  const empty = el("p", { class: "subtle stream-chat-empty" }, t("No messages yet.", "Noch keine Nachrichten."));
  const feedback = status();
  const input = el("input", { type: "text", maxlength: "1200", autocomplete: "off", placeholder: t("Write a message", "Nachricht schreiben"),
    "aria-label": t("Message in stream chat", "Nachricht im Streamchat"), disabled: true });
  const directory = createMentionDirectory({ signal, streamId, scope: log });
  const mentions = mentionComposer(input, directory, { signal });
  const send = el("button", { type: "submit", disabled: true, class: "button primary" }, t("Send", "Senden"));
  const composer = el("form", { class: "stream-chat-form" }, mentions.node, send);
  const pane = el("section", { class: "panel stream-chat", "aria-label": t("Stream chat", "Streamchat") },
    el("h2", {}, t("Stream chat", "Streamchat")), el("div", { class: "stream-chat-scroll" }, empty, log), feedback, composer);
  const scroll = log.parentElement;
  const reactions = createReactions({ endpoint, scope: streamId, user, signal, scroll });
  let recipients = [];
  let latest = messageId ? 0 : null;
  let target = messageId;
  let restartHistory = false;
  let deletionVersion = null;
  let timer;
  let polling = false;
  let posting = false;
  const rowsById = new Map();

  function syncSend() {
    input.disabled = recipients.length === 0;
    send.disabled = input.disabled || posting || !input.value.trim();
  }

  async function openContent(contextId, id, envelope) {
    if (!envelope) return null;
    try {
      const opened = await ClubCrypto.openMessage(contextId, id, envelope);
      return typeof opened?.content?.text === "string" ? opened : null;
    } catch {
      return null;
    }
  }

  async function renderMessage(message) {
    if (message.deletion) {
      const reason = (await openContent("deletion:" + streamId, message.id, message.deletion.reason))?.content.text;
      return { row: el("li", { class: "stream-chat-tombstone" },
        el("p", {}, t("Message from {author} was deleted by {moderator}.", "Nachricht von {author} wurde von {moderator} gelöscht.",
          { author: message.author.displayName, moderator: message.deletion.by.displayName })),
        reason && el("p", {}, t("Reason: {reason}", "Grund: {reason}", { reason }))) };
    }
    const opened = await openContent(streamId, message.id, message.envelope);
    if (!opened?.content.text.trim()) return null;
    const { content, key } = opened;
    const remove = message.canDelete && button(t("Delete", "Löschen"), () => confirmRemoval(message), {
      class: "stream-chat-delete ghost", "aria-label": t("Delete message from {name}", "Nachricht von {name} löschen", { name: message.author.displayName }),
    });
    const row = el("li", {},
      el("div", { class: "stream-chat-byline" }, personName(message.author),
        el("time", { datetime: message.at }, localizedTime(message.at)), remove),
      el("p", {}, renderMentionText(content, directory)));
    return { row, key };
  }

  function focusTarget() {
    const row = target && rowsById.get(target);
    if (!row || !row.isConnected) return;
    target = null;
    row.setAttribute("data-mention-focus", "");
    row.tabIndex = -1;
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
    row.addEventListener("blur", () => row.removeAttribute("data-mention-focus"), { once: true, signal });
  }

  async function insert(messages, existingOnly = false) {
    const rendered = await Promise.all(messages.map(renderMessage));
    if (signal.aborted) return;
    const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    messages.forEach((message, index) => {
      const nextMessage = rendered[index];
      if (!nextMessage) return;
      const { key, row } = nextMessage;
      const existing = rowsById.get(message.id);
      if (existing && message.deletion) {
        reactions.remove(message.id);
        existing.replaceWith(row);
      } else if (!existing && !existingOnly) {
        const next = Array.from(log.children).find(entry => Number(entry.dataset.sequence) > message.seq);
        log.insertBefore(row, next ?? null);
      }
      else return;
      row.dataset.messageId = message.id;
      row.dataset.sequence = message.seq;
      rowsById.set(message.id, row);
      if (key) reactions.track(message.id, key, row);
    });
    empty.hidden = rowsById.size > 0;
    while (log.childElementCount > 250) {
      const oldest = log.firstElementChild;
      reactions.remove(oldest.dataset.messageId);
      rowsById.delete(oldest.dataset.messageId);
      oldest.remove();
    }
    if (nearEnd) scroll.scrollTop = scroll.scrollHeight;
    focusTarget();
  }

  function confirmRemoval(message) {
    const reason = !message.own && el("textarea", { required: true, maxlength: "500", placeholder: t("Reason to share in chat", "Begründung für den Chat") });
    showDialog(t("Delete message", "Nachricht löschen"), form(
      reason ? [field(t("Reason", "Grund"), reason)] : [el("p", { class: "muted" }, t("Your message will be removed for everyone.", "Deine Nachricht wird für alle entfernt."))],
      t("Delete message", "Nachricht löschen"), async () => {
        const text = reason ? reason.value.trim() : "";
        if (reason && !text) throw new Error(t("Enter a reason for deleting the message.", "Gib einen Grund für das Löschen an."));
        const body = reason ? { reason: (await ClubCrypto.sealMessage(
          "deletion:" + streamId, message.id, { text }, recipients,
        )).envelope } : {};
        if (signal.aborted) return;
        const result = await api(endpoint + "/" + message.id, { method: "DELETE", body, signal });
        await insert([result.message], true);
        if (!signal.aborted) closeDialog();
      }));
  }

  async function poll() {
    if (signal.aborted || polling) return;
    clearTimeout(timer);
    polling = true;
    let delay = 2500;
    try {
      if (restartHistory) {
        latest = 0;
        restartHistory = false;
      }
      const query = new URLSearchParams();
      if (latest !== null) query.set("after", latest);
      if (deletionVersion !== null) query.set("deletionsAfter", deletionVersion);
      const batch = await api(endpoint + (query.size ? "?" + query : ""), { signal });
      if (signal.aborted) return;
      recipients = batch.recipients;
      await insert(batch.messages);
      if (batch.messages.length) latest = batch.messages.at(-1).seq;
      if (batch.deletions.length) await insert(batch.deletions, true);
      deletionVersion = Math.max(deletionVersion ?? 0, batch.deletionVersion);
      if (feedback.classList.contains("connection-note")) tell(feedback, "");
      if (batch.more) delay = 300;
    } catch (error) {
      if (signal.aborted) return;
      recipients = [];
      tell(feedback, error.status === 404 ? t("This stream chat is closed.", "Dieser Streamchat ist gerade geschlossen.") : t("Reconnecting to stream chat…", "Streamchat wird neu verbunden …"), "connection-note");
      delay = 5000;
    } finally {
      polling = false;
    }
    syncSend();
    if (!signal.aborted) timer = setTimeout(poll, restartHistory ? 0 : delay);
  }

  composer.addEventListener("submit", async event => {
    event.preventDefault();
    const original = input.value;
    const { text, mentions: marked, mentionedUserIds } = mentions.finish();
    if (!text || posting || !recipients.length) return;
    posting = true;
    syncSend();
    try {
      const id = crypto.randomUUID();
      const { envelope } = await ClubCrypto.sealMessage(streamId, id, { text, mentions: marked }, recipients);
      if (signal.aborted) return;
      await api(endpoint, { method: "POST", body: { id, envelope, mentionedUserIds }, signal });
      if (input.value === original) {
        input.value = "";
        mentions.reset();
      }
      if (!signal.aborted) tell(feedback, "");
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      posting = false;
      if (!signal.aborted) syncSend();
    }
  }, { signal });
  input.addEventListener("input", syncSend, { signal });
  pane.addEventListener("open-message", event => {
    target = event.detail?.messageId;
    if (!target) return;
    if (rowsById.has(target)) focusTarget();
    else {
      restartHistory = true;
      poll();
    }
  }, { signal });
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  poll();
  return pane;
}
