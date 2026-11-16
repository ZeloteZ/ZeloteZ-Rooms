import { api, button, closeDialog, el, field, form, identifier, localizedTime, personMark, personName, showDialog, status, tell, validHttpLink } from "./ui.js";
import { locale, t } from "./i18n.js";
import { createMentionDirectory, mentionComposer, renderMentionText } from "./mentions.js";

const maxFiles = 4;
const maxFileSize = 12 * 1024 * 1024;
const initialHistoryRows = 80;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const videoTypes = new Set(["video/mp4", "video/webm", "video/ogg"]);
const audioTypes = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav"]);
const messageGroupWindow = 5 * 60 * 1000;

function updateMessageGroup(row) {
  if (!row) return;
  const previous = row.previousElementSibling;
  const distance = Number(row.dataset.sentAt) - Number(previous?.dataset.sentAt);
  row.classList.toggle("message-continuation", Boolean(row.dataset.authorId) &&
    row.dataset.authorId === previous?.dataset.authorId && distance >= 0 && distance <= messageGroupWindow);
}

function messageText(content, directory) {
  const paragraph = el("p", { class: "message-text" });
  let preview;
  function linkify(text) {
    const parts = [];
    let offset = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
      const candidate = match[0].replace(/[.,!?;:)\]}]+$/u, "");
      const href = validHttpLink(candidate);
      if (!href) continue;
      parts.push(text.slice(offset, match.index),
        el("a", { href, target: "_blank", rel: "noopener noreferrer" }, candidate));
      offset = match.index + candidate.length;
      if (!preview && href.startsWith("https:")) {
        const url = new URL(href);
        preview = el("a", { class: "link-preview", href, rel: "noopener noreferrer", target: "_blank" },
          el("span", { class: "link-arrow", "aria-hidden": "true" }, "↗"),
          el("span", {}, el("strong", {}, url.hostname),
            el("span", { class: "subtle" }, url.pathname === "/" ? t("Open link", "Link öffnen") : url.pathname)));
      }
    }
    parts.push(text.slice(offset));
    return parts;
  }
  paragraph.append(...renderMentionText(content, directory, linkify));
  return [paragraph, preview];
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return "";
  return bytes >= 1024 * 1024
    ? (bytes / (1024 * 1024)).toLocaleString(locale(), { maximumFractionDigits: 1 }) + " MB"
    : Math.ceil(bytes / 1024) + " KB";
}

function readableFilename(name) {
  const text = String(name || t("Attachment", "Anhang")).replace(/[\\/\u0000-\u001f\u007f]/gu, "_").trim();
  return text.slice(0, 160) || t("Attachment", "Anhang");
}

function renderAttachment(context, file, key, fileEndpoint, urls) {
  const name = readableFilename(file.name);
  const isImage = imageTypes.has(file.type);
  const isVideo = videoTypes.has(file.type);
  const isAudio = audioTypes.has(file.type);
  const format = isImage ? t("Image", "Bild") : isVideo ? "Video" : isAudio ? "Audio" : t("File", "Datei");
  const size = sizeLabel(file.size);
  const feedback = status();
  const view = el("div", { class: "attached-file stack" }, feedback);
  const load = button(isImage || isVideo || isAudio ? t("Show", "Anzeigen") : t("Open", "Öffnen"), async () => {
    load.disabled = true;
    tell(feedback, t("Decrypting file…", "Datei wird entschlüsselt …"));
    try {
      const stored = await api(fileEndpoint + identifier(file.id), { buffer: true, signal: context.signal });
      const bytes = await ClubCrypto.decryptFile(key, file.id, stored);
      if (context.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: isImage || isVideo || isAudio ? file.type : "application/octet-stream" }));
      urls.add(url);
      const media = isImage ? el("img", { class: "attachment-preview", src: url, alt: name, loading: "lazy" })
        : isVideo ? el("video", { src: url, class: "attachment-preview", controls: true, playsinline: true, preload: "metadata", "aria-label": name })
        : isAudio ? el("audio", { src: url, controls: true, preload: "metadata", "aria-label": name }) : null;
      view.replaceChildren(media ?? el("p", { class: "subtle" }, t("File decrypted", "Datei entschlüsselt")),
        el("a", { class: "attachment", href: url, download: name }, t("Download file · {name}", "Datei herunterladen · {name}", { name })));
    } catch (error) {
      if (!context.signal.aborted) tell(feedback, error.message || t("The file could not be decrypted.", "Die Datei konnte nicht entschlüsselt werden."), "error");
      load.disabled = false;
    }
  }, { "aria-label": t("Open {name}", "{name} öffnen", { name }) });
  view.prepend(el("div", { class: "inline attached-file-row" },
    el("div", { class: "attachment-details" }, el("strong", {}, name),
      el("p", { class: "subtle" }, size ? format + " · " + size : format)),
    load));
  return view;
}

export function renderChat(context, channel, edit) {
  const { signal } = context;
  const timeFormat = new Intl.DateTimeFormat(locale(), { timeStyle: "short" });
  const messageEndpoint = "channels/" + identifier(channel.id) + "/messages";
  const fileEndpoint = "channels/" + identifier(channel.id) + "/files/";
  const rows = new Map();
  const tombstones = new Set();
  const fileViews = new Map();
  const list = el("ol", { class: "message-list", role: "log", tabindex: "0", "aria-label": t("Messages", "Nachrichten"), "aria-live": "off" });
  const mentionDirectory = createMentionDirectory({ signal, channelId: channel.id, scope: list });
  const older = button(t("Load older messages", "Ältere Nachrichten laden"), loadOlder, { hidden: true });
  const empty = el("li", { class: "muted" }, t("Loading messages…", "Nachrichten werden geladen …"));
  const connection = status();
  const feedback = status();
  const input = el("textarea", { rows: "1", maxlength: "4000", enterkeyhint: "send",
    "aria-label": t("Write a message", "Nachricht schreiben"), "aria-describedby": "message-shortcuts", placeholder: t("Write a message…", "Nachricht schreiben …") });
  const mentions = mentionComposer(input, mentionDirectory, { signal });
  const fileInput = el("input", { type: "file", multiple: true, hidden: true, disabled: true });
  const attach = button(el("span", { class: "composer-clip", "aria-hidden": "true" }), () => fileInput.click(),
    { class: "icon-button composer-attach", "aria-label": t("Attach files", "Dateien anhängen"), title: t("Attach files", "Dateien anhängen"), disabled: true });
  const attachments = el("ul", { class: "composer-attachments", hidden: true, "aria-label": t("Selected attachments", "Ausgewählte Anhänge") });
  const send = el("button", { class: "button primary", type: "submit", disabled: true }, t("Send", "Senden"));
  const composer = el("form", { class: "message-form stack" }, attachments,
    el("div", { class: "write-row" }, attach, mentions.node, send),
    fileInput, feedback, el("p", { class: "composer-shortcuts", id: "message-shortcuts" },
      t("Enter to send · Shift + Enter for a new line", "Enter zum Senden · Umschalt + Enter für eine neue Zeile")));
  list.append(empty);
  let files = [];
  let recipients = [];
  let initialized = false;
  let fetching = false;
  let loadingOlder = false;
  let refreshingHistory = false;
  let sending = false;
  let oldest = Infinity;
  let newest = 0;
  let historyVersion = 0;
  let deletionVersion = 0;
  let timer;
  let pendingFocus;
  let locating = false;
  let highlighted;
  let highlightTimer;

  function updateSend() {
    const busy = !initialized || sending || input.disabled;
    send.disabled = busy || (!input.value.trim() && !files.length);
    fileInput.disabled = busy || files.length >= maxFiles;
    attach.disabled = fileInput.disabled;
    for (const remove of attachments.querySelectorAll("button")) remove.disabled = busy;
  }

  function sizeInput() {
    input.style.setProperty("--composer-input-height", "0px");
    input.style.setProperty("--composer-input-height", Math.min(input.scrollHeight + 2, 156) + "px");
  }

  function updateAttachments() {
    attachments.hidden = files.length === 0;
    attachments.replaceChildren(...files.map((file, index) => el("li", { class: "attachment-chip" },
      el("span", { class: "attachment-chip-name", title: file.name }, file.name),
      button("×", () => {
        files = files.filter((__, fileIndex) => fileIndex !== index);
        updateAttachments();
        updateSend();
        const next = attachments.children[Math.min(index, files.length - 1)];
        (next?.querySelector("button") ?? attach).focus();
      }, { class: "ghost icon-button", "aria-label": t("Remove attachment · {name}", "Anhang entfernen · {name}", { name: file.name }) }))));
  }

  input.addEventListener("input", () => {
    sizeInput();
    updateSend();
  });
  input.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!send.disabled) composer.requestSubmit(send);
  });
  fileInput.addEventListener("change", () => {
    const next = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    if (files.length + next.length > maxFiles || next.some(file => file.size > maxFileSize)) {
      tell(feedback, t("You can attach up to four files of 12 MiB each.", "Pro Nachricht sind bis zu vier Dateien mit je 12 MiB möglich."), "error");
      return;
    }
    tell(feedback, "");
    files = files.concat(next);
    updateAttachments();
    updateSend();
  });
  composer.addEventListener("submit", async event => {
    event.preventDefault();
    if (send.disabled) return;
    const restoreInputFocus = composer.contains(document.activeElement);
    sending = true;
    updateSend();
    composer.setAttribute("aria-busy", "true");
    input.readOnly = true;
    tell(feedback, files.length ? t("Encrypting the message and attachments…", "Nachricht und Dateien werden verschlüsselt …") : "");
    const draft = mentions.finish();
    const pendingFiles = [...files];
    try {
      let result;
      try {
        result = await sendMessage(draft, pendingFiles);
      } catch (error) {
        if (error.status !== 409) throw error;
        const fresh = await api(messageEndpoint + "?after=" + newest, { signal });
        recipients = fresh.recipients ?? [];
        result = await sendMessage(draft, pendingFiles);
      }
      if (signal.aborted) return;
      input.value = "";
      mentions.reset();
      sizeInput();
      files = [];
      updateAttachments();
      if (result?.message) await addMessages([result.message]);
      list.scrollTop = list.scrollHeight;
      tell(feedback, "");
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      sending = false;
      input.readOnly = false;
      composer.removeAttribute("aria-busy");
      updateSend();
      if (!signal.aborted && restoreInputFocus &&
          (composer.contains(document.activeElement) || document.activeElement === document.body)) {
        input.focus({ preventScroll: true });
      }
    }
  });

  async function sendMessage(draft, fileList) {
    const id = crypto.randomUUID();
    const named = fileList.map(file => ({ id: crypto.randomUUID(), name: readableFilename(file.name), type: file.type || "application/octet-stream", size: file.size }));
    if (!recipients.length) {
      const fresh = await api(messageEndpoint + "?after=" + newest, { signal });
      recipients = fresh.recipients ?? [];
    }
    if (!recipients.length) throw new Error(t("The members’ encryption keys are unavailable right now.", "Die Schlüssel der Mitglieder sind gerade nicht verfügbar."));
    const content = { text: draft.text, attachments: named };
    if (draft.mentions.length) content.mentions = draft.mentions;
    const { envelope, key } = await ClubCrypto.sealMessage(channel.id, id, content, recipients);
    for (const [index, file] of fileList.entries()) {
      const fileId = named[index].id;
      const blob = await ClubCrypto.encryptFile(key, fileId, file);
      await api(fileEndpoint + identifier(fileId), { method: "PUT", body: blob, binary: true, signal });
    }
    const body = { id, envelope, attachmentIds: named.map(file => file.id) };
    const notified = draft.mentionedUserIds.filter(userId => recipients.some(recipient => recipient.id === userId));
    if (notified.length) body.mentionedUserIds = notified;
    return api(messageEndpoint, { method: "POST", body, signal });
  }

  function confirmRemoval(message, own) {
    const reason = own ? null : el("input", { required: true, maxlength: "300", autocomplete: "off" });
    showDialog(own ? t("Delete message?", "Nachricht löschen?") : t("Moderate message", "Nachricht moderieren"),
      form([
        el("p", { class: "muted" }, t("The message and its attachments will be deleted for everyone.", "Die Nachricht und ihre Anhänge werden für alle gelöscht.")),
        reason && field(t("Reason for deletion", "Grund für die Löschung"), reason),
        button(t("Cancel", "Abbrechen"), closeDialog, { class: "ghost" }),
      ], t("Delete for everyone", "Für alle löschen"), async () => {
        let payload = {};
        if (reason) {
          const text = reason.value.trim();
          if (!text) throw new Error(t("Enter a reason for deleting the message.", "Gib einen Grund für die Löschung an."));
          const fresh = await api(messageEndpoint + "?after=" + newest, { signal });
          const { envelope } = await ClubCrypto.sealMessage(ClubCrypto.deletionScope(channel.id), message.id, { reason: text }, fresh.recipients);
          payload = { reason: envelope };
        }
        const result = await api(messageEndpoint + "/" + identifier(message.id), { method: "DELETE", body: payload, signal });
        if (!signal.aborted) {
          await addMessages([result.message], { keepPosition: true });
          if (!signal.aborted) {
            closeDialog();
            rows.get(message.id)?.focus({ preventScroll: true });
          }
        }
      }));
  }

  async function deletionNote(message, author) {
    const { by, reason } = message.deleted;
    const names = { author: author.displayName ?? String(author), moderator: by.displayName };
    const note = el("p", { class: "message-removed" }, reason
      ? t("Message from {author} was deleted by {moderator}.", "Nachricht von {author} wurde von {moderator} gelöscht.", names)
      : t("Message from {author} was deleted.", "Nachricht von {author} wurde gelöscht.", names));
    if (reason) {
      try {
        const result = await ClubCrypto.openMessage(ClubCrypto.deletionScope(channel.id), message.id, reason);
        const text = result?.content?.reason;
        if (typeof text === "string" && text.trim()) note.append(t(" Reason: {text}", " Grund: {text}", { text }));
        else note.append(t(" The reason is unavailable to your account.", " Der Grund ist für dein Konto nicht verfügbar."));
      } catch {
        note.append(t(" The reason could not be decrypted.", " Der Grund konnte nicht entschlüsselt werden."));
      }
    }
    return note;
  }

  function releaseFiles(id) {
    const files = fileViews.get(id);
    if (!files) return;
    files.controller.abort();
    for (const node of rows.get(id)?.querySelectorAll("video, audio") ?? []) {
      node.pause();
      node.removeAttribute("src");
      node.load();
    }
    for (const url of files.urls) URL.revokeObjectURL(url);
    fileViews.delete(id);
  }

  async function messageRow(message) {
    const author = message.author ?? t("Unknown", "Unbekannt");
    const date = new Date(message.at);
    const time = Number.isFinite(Number(date)) ? timeFormat.format(date) : "";
    const body = el("div", { class: "message-body" },
      el("div", { class: "message-meta" }, !message.deleted && personName(author),
        el("time", { datetime: time ? date.toISOString() : undefined, title: localizedTime(message.at) }, time)));
    let fileView;
    let remove;
    if (message.deleted) {
      body.append(await deletionNote(message, author));
    } else {
      const own = context.user?.id === message.author?.id;
      if (own || edit) {
        remove = button(t("Delete", "Löschen"), () => confirmRemoval(message, own), { class: "ghost message-delete",
          "aria-label": own ? t("Delete your message", "Eigene Nachricht löschen")
            : t("Delete message from {name}", "Nachricht von {name} löschen", { name: author.displayName }) });
      }
      try {
        const result = await ClubCrypto.openMessage(channel.id, message.id, message.envelope);
        if (!result) {
          body.append(el("p", { class: "subtle" }, t("Your account does not have a key for this message.", "Für diese Nachricht ist auf deinem Konto kein Schlüssel verfügbar.")));
        } else {
          const text = result.content?.text;
          if (typeof text === "string" && text) body.append(...messageText(result.content, mentionDirectory).filter(Boolean));
          const attachments = Array.isArray(result.content?.attachments)
            ? result.content.attachments.filter(attachment => typeof attachment?.id === "string") : [];
          if (attachments.length) {
            fileView = { controller: new AbortController(), urls: new Set() };
            const fileContext = { ...context, signal: AbortSignal.any([signal, fileView.controller.signal]) };
            body.append(...attachments.map(attachment => renderAttachment(fileContext, attachment, result.key, fileEndpoint, fileView.urls)));
          }
        }
      } catch {
        body.append(el("p", { class: "error" }, t("This message could not be decrypted.", "Diese Nachricht konnte nicht entschlüsselt werden.")));
      }
    }
    const row = el("li", { class: "message-row", "data-message-id": message.id, "data-sequence": message.seq,
      "data-author-id": !message.deleted && message.author?.id, "data-deleted": Boolean(message.deleted),
      "data-reason-granted": Boolean(message.deleted?.reason?.historyGrant),
      tabindex: "-1", "data-sent-at": date.getTime() }, personMark(author), body, remove);
    return { row, fileView };
  }

  async function addMessages(messages, { olderBatch = false, keepPosition = false } = {}) {
    const canRender = message => {
      const current = rows.get(message.id);
      if (message.deleted) {
        return !current?.hasAttribute("data-deleted") ||
          Boolean(message.deleted.reason?.historyGrant && !current.hasAttribute("data-reason-granted"));
      }
      return !current && !tombstones.has(message.id);
    };
    for (const message of messages) if (message?.deleted) tombstones.add(message.id);
    const incoming = messages.filter(msg => msg && canRender(msg) && Number.isSafeInteger(Number(msg.seq)));
    if (!incoming.length) return;
    const elements = await Promise.all(incoming.map(async msg => [msg, await messageRow(msg)]));
    if (signal.aborted) return;
    const wasNearEnd = list.scrollHeight - list.clientHeight - list.scrollTop < 64;
    const preservedHeight = list.scrollHeight;
    const preservedScroll = list.scrollTop;
    const viewTop = keepPosition ? list.getBoundingClientRect().top : 0;
    const anchor = keepPosition && Array.from(list.children).find(row =>
      row !== empty && row.getBoundingClientRect().bottom > viewTop);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    empty.remove();
    for (const [msg, { row, fileView }] of elements) {
      if (!canRender(msg)) continue;
      const previous = rows.get(msg.id);
      const sequence = Number(msg.seq);
      const next = previous ? previous.nextElementSibling : Array.from(list.children).find(child => Number(child.dataset.sequence) > sequence);
      if (previous) {
        releaseFiles(msg.id);
        const hadFocus = previous.contains(document.activeElement);
        list.insertBefore(row, previous);
        previous.remove();
        if (hadFocus) row.focus({ preventScroll: true });
      } else {
        list.insertBefore(row, next ?? null);
        oldest = Math.min(oldest, sequence);
      }
      updateMessageGroup(row);
      updateMessageGroup(next);
      rows.set(msg.id, row);
      if (fileView) fileViews.set(msg.id, fileView);
    }
    if (anchor) list.scrollTop += (rows.get(anchor.dataset.messageId) ?? anchor).getBoundingClientRect().top - anchorTop;
    else if (olderBatch) list.scrollTop = preservedScroll + list.scrollHeight - preservedHeight;
    else if (wasNearEnd) list.scrollTop = list.scrollHeight;
  }

  async function loadOlder() {
    if (!Number.isFinite(oldest) || loadingOlder || refreshingHistory) return;
    loadingOlder = true;
    older.disabled = true;
    try {
      const first = oldest;
      const batch = await api(messageEndpoint + "?before=" + first, { signal });
      await addMessages(batch.messages ?? [], { olderBatch: true });
      older.hidden = !batch.more;
      return oldest < first;
    } catch (error) {
      if (!signal.aborted) tell(connection, error.message, "error");
    } finally {
      loadingOlder = false;
      older.disabled = false;
      void locateMessage();
    }
  }

  function requestMessage(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) return;
    pendingFocus = id;
    void locateMessage();
  }

  async function locateMessage() {
    if (!pendingFocus || !initialized || fetching || locating || loadingOlder || refreshingHistory || signal.aborted) return;
    locating = true;
    const target = pendingFocus;
    try {
      while (!signal.aborted && pendingFocus === target) {
        const row = rows.get(target);
        if (row) {
          highlighted?.removeAttribute("data-mention-focus");
          clearTimeout(highlightTimer);
          highlighted = row;
          row.setAttribute("data-mention-focus", "");
          row.focus({ preventScroll: true });
          row.scrollIntoView({ block: "center" });
          highlightTimer = setTimeout(() => row.removeAttribute("data-mention-focus"), 4500);
          break;
        }
        if (older.hidden || !await loadOlder()) break;
      }
    } finally {
      locating = false;
      if (pendingFocus === target) pendingFocus = undefined;
      else void locateMessage();
    }
  }

  function setConnection(message, kind) {
    if (connection.textContent !== message) tell(connection, message, kind);
  }

  async function loadGrantedHistory() {
    if (loadingOlder) return;
    refreshingHistory = true;
    older.disabled = true;
    try {
      const batch = await api(messageEndpoint + "?grantsAfter=" + historyVersion, { signal });
      if (signal.aborted) return;
      const { nextGrantVersion, messages } = batch;
      if (!Number.isSafeInteger(nextGrantVersion) || nextGrantVersion <= historyVersion || !Array.isArray(messages)) return;
      // Keep the loaded range contiguous and send a large archive through normal older pagination.
      const withinRange = messages.filter(msg => Number(msg.seq) >= oldest);
      const beforeRange = messages.filter(msg => Number(msg.seq) < oldest)
        .sort((first, second) => Number(second.seq) - Number(first.seq));
      const extraRows = older.hidden ? Math.max(0, initialHistoryRows - rows.size) : 0;
      const visible = withinRange.concat(beforeRange.slice(0, extraRows));
      await addMessages(visible, { keepPosition: true });
      if (visible.length < messages.length) older.hidden = false;
      historyVersion = nextGrantVersion;
      return batch.more;
    } finally {
      refreshingHistory = false;
      older.disabled = false;
    }
  }

  async function poll() {
    if (signal.aborted || fetching) return;
    clearTimeout(timer);
    fetching = true;
    let delay = 3000;
    try {
      const fullPage = !initialized || (newest === 0 && rows.size === 0);
      const result = await api(messageEndpoint + (fullPage ? "" : "?after=" + newest + "&deletionsAfter=" + deletionVersion), { signal });
      if (signal.aborted) return;
      const messages = result.messages ?? [];
      recipients = result.recipients ?? [];
      const deletions = result.deletions ?? [];
      for (const message of deletions) tombstones.add(message.id);
      const visibleDeletions = deletions.filter(message => rows.has(message.id) || message.seq >= oldest);
      await addMessages(visibleDeletions, { keepPosition: true });
      if (visibleDeletions.length < deletions.length) older.hidden = false;
      if (Number.isSafeInteger(result.nextDeletionVersion)) deletionVersion = result.nextDeletionVersion;
      if (result.moreDeletions) delay = 1000;
      await addMessages(messages);
      if (signal.aborted) return;
      for (const msg of messages) newest = Math.max(newest, Number(msg.seq) || 0);
      const revision = Number.isSafeInteger(result.historyVersion) ? result.historyVersion : 0;
      if (fullPage) {
        historyVersion = revision;
        deletionVersion = Number.isSafeInteger(result.deletionVersion) ? result.deletionVersion : 0;
        older.hidden = !result.more;
        initialized = true;
        empty.textContent = t("No messages yet.", "Noch keine Nachrichten.");
        list.setAttribute("aria-live", "polite");
        updateSend();
      } else if (revision > historyVersion) {
        if (await loadGrantedHistory()) delay = 1000;
      }
      setConnection("");
    } catch (error) {
      if (!signal.aborted) {
        setConnection(error.status === 403 ? t("You no longer have access to this chat.", "Du hast keinen Zugriff mehr auf diesen Chat.") : t("Reconnecting to the chat.", "Der Chat wird gerade neu verbunden."), "error");
        if (error.status === 403 || error.status === 404) {
          input.disabled = true;
          updateSend();
          context.refresh();
          return;
        }
      }
    } finally {
      fetching = false;
      void locateMessage();
    }
    if (!signal.aborted) timer = setTimeout(poll, delay);
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    clearTimeout(highlightTimer);
    for (const id of fileViews.keys()) releaseFiles(id);
  }, { once: true });

  const pane = el("section", { class: "panel conversation" },
    el("div", { class: "conversation-heading section-heading" },
      el("div", { class: "stack chat-title" }, el("h2", {}, "# " + channel.title), el("span", { class: "tag" }, t("End-to-end encrypted", "Ende-zu-Ende-verschlüsselt"))),
      edit),
    el("div", { class: "chat-controls stack" }, older, connection),
    list,
    composer);
  pane.addEventListener("open-message", event => requestMessage(event.detail?.messageId), { signal });
  requestMessage(context.messageId);
  poll();
  return pane;
}
