import { api, button, closeDialog, el, field, form, identifier, localizedTime, notify, openChatImage, personMark, personName, select, showDialog, status, tell, validHttpLink } from "./ui.js";
import { locale, t } from "./i18n.js";
import { createMentionDirectory, mentionComposer, renderMentionText } from "./mentions.js";
import { createReactions } from "./reactions.js";
import { canPreviewChatImage } from "./chat-media.js";

const maxFiles = 4;
const maxFileSize = 12 * 1024 * 1024;
const encryptedFileOverhead = 28; // 12-byte nonce and 16-byte authentication tag.
const automaticLoadSlots = 2;
const maxCachedAttachments = 16;
const maxCachedAttachmentBytes = 96 * 1024 * 1024;
const attachmentId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
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

function normalizeAttachments(entries) {
  if (!Array.isArray(entries)) return [];
  const files = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || !attachmentId.test(entry.id) || files.has(entry.id)) continue;
    files.set(entry.id, entry);
    if (files.size >= maxFiles) break;
  }
  return [...files.values()];
}

function renderAttachment(signal, file, key, fileEndpoint, retain) {
  const name = readableFilename(file.name);
  const isImage = imageTypes.has(file.type);
  const isVideo = videoTypes.has(file.type);
  const isAudio = audioTypes.has(file.type);
  const format = isImage ? t("Image", "Bild") : isVideo ? "Video" : isAudio ? "Audio" : t("File", "Datei");
  const size = sizeLabel(file.size);
  const feedback = status();
  const view = el("div", { class: "attached-file stack" }, feedback);
  const load = button(isImage || isVideo || isAudio ? t("Show", "Anzeigen") : t("Open", "Öffnen"), () => loadFile(), {
    "aria-label": t("Open {name}", "{name} öffnen", { name }),
  });
  let attemptedLimit;
  let closePreview;
  let url;
  let media;
  const row = el("div", { class: "inline attached-file-row" },
    el("div", { class: "attachment-details" }, el("strong", {}, name),
      el("p", { class: "subtle" }, size ? format + " · " + size : format)), load);
  view.prepend(row);

  async function loadFile(limit = null, automatic = false) {
    if (load.disabled || signal.aborted) return;
    load.disabled = true;
    tell(feedback, t("Decrypting file…", "Datei wird entschlüsselt …"));
    try {
      const cap = limit === null ? "" : "?maxBytes=" + (Math.min(limit, maxFileSize) + encryptedFileOverhead);
      const stored = await api(fileEndpoint + identifier(file.id) + cap, { buffer: true, signal });
      if (signal.aborted) return;
      if (stored === null) {
        tell(feedback, "");
        load.disabled = false;
        return;
      }
      const bytes = await ClubCrypto.decryptFile(key, file.id, stored);
      if (signal.aborted) return;
      const preview = isImage && (!automatic || canPreviewChatImage(file.type, bytes));
      url = URL.createObjectURL(new Blob([bytes], { type: isImage || isVideo || isAudio ? file.type : "application/octet-stream" }));
      const localPlayback = isVideo && window.roomsNativeMedia === true && el("a", {
        href: url + "#rooms-play-" + file.type.slice("video/".length), class: "button", hidden: true,
      }, t("Play video locally", "Video lokal abspielen"));
      const open = event => {
        closePreview = openChatImage(url, name, event.currentTarget);
      };
      media = isVideo ? el("video", { class: "attachment-preview", controls: true, playsinline: true, preload: "metadata", "aria-label": name })
        : isAudio ? el("audio", { controls: true, preload: "none", "aria-label": name }) : null;
      if (media) {
        const player = media;
        player.addEventListener("error", () => {
          if (media !== player || signal.aborted) return;
          const error = localPlayback
            ? t("The built-in video player reported an error.", "Beim eingebauten Videoplayer ist ein Fehler aufgetreten.")
            : t("Playback failed on this device. You can download the file and open it in a media player.",
              "Die Wiedergabe auf diesem Gerät ist fehlgeschlagen. Du kannst die Datei herunterladen und in einem Mediaplayer öffnen.");
          const code = player.error?.code;
          tell(feedback, Number.isInteger(code) ? error + " " + t("(Media error {code})", "(Medienfehler {code})", { code }) : error, "error");
          if (localPlayback) {
            player.hidden = true;
            localPlayback.hidden = false;
          }
        }, { once: true, signal });
        player.src = url;
      }
      const image = isImage && button(preview ? el("img", { class: "attachment-preview", src: url, alt: "", loading: "lazy" })
        : t("Show image", "Bild anzeigen"), open, { class: preview ? "chat-image-trigger" : "", "aria-haspopup": "dialog",
        "aria-label": t("Enlarge {name}", "{name} vergrößern", { name }) });
      tell(feedback, "");
      view.replaceChildren(image || media || el("p", { class: "subtle" }, t("File decrypted", "Datei entschlüsselt")), feedback,
        ...(localPlayback ? [localPlayback] : []),
        el("a", { class: "attachment", href: url, download: name }, t("Download file · {name}", "Datei herunterladen · {name}", { name })));
      retain(attachment, bytes.byteLength);
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message || t("The file could not be decrypted.", "Die Datei konnte nicht entschlüsselt werden."), "error");
      load.disabled = false;
    }
  }
  const attachment = {
    node: view,
    canAutoLoad: limit => !load.disabled && !signal.aborted && limit !== attemptedLimit &&
      (limit === null || (Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= limit)),
    autoLoad(limit) {
      attemptedLimit = limit;
      return loadFile(limit, true);
    },
    inUse: () => view.contains(document.activeElement) || Boolean(media && !media.paused) ||
      document.querySelector("#dialog[open] .chat-image-viewer img")?.src === url,
    release() {
      if (!url) return;
      closePreview?.();
      closePreview = undefined;
      if (media) {
        const player = media;
        media = null;
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
      URL.revokeObjectURL(url);
      url = undefined;
      attemptedLimit = undefined;
      load.disabled = false;
      tell(feedback, "");
      view.replaceChildren(row, feedback);
    },
  };
  return attachment;
}

export function renderChat(context, channel, edit) {
  const { signal } = context;
  const timeFormat = new Intl.DateTimeFormat(locale(), { timeStyle: "short" });
  const messageEndpoint = "channels/" + identifier(channel.id) + "/messages";
  const fileEndpoint = "channels/" + identifier(channel.id) + "/files/";
  const rows = new Map();
  const tombstones = new Set();
  const departedSequences = new Map();
  const fileViews = new Map();
  const list = el("ol", { class: "message-list", role: "log", tabindex: "0", "aria-label": t("Messages", "Nachrichten"), "aria-live": "off" });
  const reactions = createReactions({ endpoint: messageEndpoint, scope: channel.id, user: context.user, signal, scroll: list });
  const attachmentJobs = new WeakMap();
  const visibleAttachments = new Set();
  const loadedAttachments = new Map();
  let loadedBytes = 0;
  let activeLoads = 0;
  const fileObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const attachment = attachmentJobs.get(entry.target);
      if (!attachment) continue;
      if (entry.isIntersecting) visibleAttachments.add(attachment);
      else visibleAttachments.delete(attachment);
    }
    trimAttachments();
    loadVisibleAttachments();
  }, { root: list });
  context.profileUpdates?.addEventListener("change", loadVisibleAttachments, { signal });
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
  const unavailable = el("p", { class: "direct-read-only subtle", hidden: true },
    t("You can send messages while you’re friends.", "Ihr könnt Nachrichten schreiben, solange ihr befreundet seid."));
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
  let movementVersion = 0;
  let historyGeneration = 0;
  let timer;
  let pendingFocus;
  let locating = false;
  let highlighted;
  let highlightTimer;
  let canSend = context.direct?.canSend ?? true;

  function releaseAttachment(attachment) {
    loadedBytes -= loadedAttachments.get(attachment) ?? 0;
    loadedAttachments.delete(attachment);
    attachment.release();
  }

  function trimAttachments(reserved = 0) {
    for (const attachment of loadedAttachments.keys()) {
      if (loadedAttachments.size + reserved <= maxCachedAttachments &&
          loadedBytes + reserved * maxFileSize <= maxCachedAttachmentBytes) return true;
      if (!visibleAttachments.has(attachment) && !attachment.inUse()) releaseAttachment(attachment);
    }
    return loadedAttachments.size + reserved <= maxCachedAttachments && loadedBytes + reserved * maxFileSize <= maxCachedAttachmentBytes;
  }

  function retainAttachment(attachment, bytes) {
    loadedAttachments.set(attachment, bytes);
    loadedBytes += bytes;
    trimAttachments();
  }

  function loadVisibleAttachments() {
    if (signal.aborted || context.user?.autoLoadAttachments === false) return;
    const limit = context.user?.autoLoadAttachmentMaxBytes ?? null;
    for (const attachment of visibleAttachments) {
      if (activeLoads >= automaticLoadSlots) break;
      if (!attachment.canAutoLoad(limit)) continue;
      if (!trimAttachments(activeLoads + 1)) break;
      activeLoads++;
      void attachment.autoLoad(limit).finally(() => {
        activeLoads--;
        loadVisibleAttachments();
      });
    }
  }

  function updateSend() {
    const busy = !canSend || !initialized || sending || input.disabled;
    send.disabled = busy || (!input.value.trim() && !files.length);
    fileInput.disabled = busy || files.length >= maxFiles;
    attach.disabled = fileInput.disabled;
    for (const remove of attachments.querySelectorAll("button")) remove.disabled = busy;
  }

  function updateDirect(canWrite) {
    canSend = canWrite;
    input.disabled = !canWrite;
    composer.hidden = !canWrite;
    unavailable.hidden = canWrite;
    updateSend();
  }

  function reportRead() {
    if (!context.direct || signal.aborted || !list.isConnected || document.hidden ||
        pendingFocus || locating || list.scrollHeight - list.clientHeight - list.scrollTop >= 64) return;
    const sequence = Number(list.lastElementChild?.dataset.sequence);
    if (Number.isSafeInteger(sequence) && sequence > 0) context.direct.onRead(sequence);
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
    if (notified.length && !context.direct) body.mentionedUserIds = notified;
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
          const scope = ClubCrypto.deletionScope(message.cryptoChannelId ?? channel.id);
          const { envelope } = await ClubCrypto.sealMessage(scope, message.id, { reason: text }, fresh.recipients);
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

  function confirmMove(message) {
    const destinations = context.moveDestinations();
    if (!destinations.length) {
      notify(t("There are no other text channels in this room.", "Dieser Raum hat keine anderen Text-Channels."));
      return;
    }
    const picker = select([
      ["", t("Choose a channel", "Channel auswählen")],
      ...destinations.map(destination => [destination.id, "# " + destination.title]),
    ], "");
    picker.required = true;
    const panel = form([
      el("p", { class: "muted" }, t("Move this message and its attachments to another channel.", "Verschiebe diese Nachricht samt Anhängen in einen anderen Channel.")),
      field(t("Destination channel", "Ziel-Channel"), picker),
      button(t("Cancel", "Abbrechen"), closeDialog, { class: "ghost" }),
    ], t("Move message", "Nachricht verschieben"), async () => {
      const destination = destinations.find(candidate => candidate.id === picker.value);
      if (!destination) return;
      await api(messageEndpoint + "/" + identifier(message.id) + "/move", {
        method: "POST", body: { channelId: destination.id }, signal,
      });
      if (signal.aborted) return;
      const restoreFocus = panel.isConnected;
      if (restoreFocus) closeDialog();
      removeMovedMessages([{ messageId: message.id, seq: message.seq }], restoreFocus ? message.id : null);
      notify(t("Message moved to #{channel}.", "Nachricht in #{channel} verschoben.", { channel: destination.title }));
      void poll();
    });
    showDialog(t("Move message", "Nachricht verschieben"), panel);
    picker.focus();
  }

  async function deletionNote(message, author) {
    const { by, reason } = message.deleted;
    const names = { author: author.displayName ?? String(author), moderator: by.displayName };
    const note = el("p", { class: "message-removed" }, reason
      ? t("Message from {author} was deleted by {moderator}.", "Nachricht von {author} wurde von {moderator} gelöscht.", names)
      : t("Message from {author} was deleted.", "Nachricht von {author} wurde gelöscht.", names));
    if (reason) {
      try {
        const scope = ClubCrypto.deletionScope(message.cryptoChannelId ?? channel.id);
        const result = await ClubCrypto.openMessage(scope, message.id, reason, channel.id);
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
    for (const attachment of files.attachments) {
      fileObserver.unobserve(attachment.node);
      attachmentJobs.delete(attachment.node);
      visibleAttachments.delete(attachment);
      releaseAttachment(attachment);
    }
    fileViews.delete(id);
  }

  function removeMovedMessages(moves, focusId = null) {
    const removed = new Set();
    for (const { messageId, seq } of moves) {
      if (typeof messageId !== "string" || !Number.isSafeInteger(seq) || seq < 1) continue;
      const latest = Math.max(departedSequences.get(messageId) ?? 0, seq);
      departedSequences.set(messageId, latest);
      const row = rows.get(messageId);
      if (row && Number(row.dataset.sequence) <= latest) removed.add(row);
    }
    if (!removed.size) return;
    const retained = Array.from(list.children).filter(row => !removed.has(row));
    const viewTop = list.getBoundingClientRect().top;
    const anchor = retained.find(row => row.getBoundingClientRect().bottom > viewTop);
    const anchorTop = anchor?.getBoundingClientRect().top;
    let nextFocus;
    for (const row of removed) {
      const id = row.dataset.messageId;
      if (id === focusId || row.contains(document.activeElement)) {
        nextFocus = retained.find(candidate => Number(candidate.dataset.sequence) > Number(row.dataset.sequence)) ?? retained.at(-1) ?? list;
      }
      const next = row.nextElementSibling;
      releaseFiles(id);
      reactions.remove(id);
      rows.delete(id);
      row.remove();
      updateMessageGroup(next);
    }
    if (!rows.size) list.append(empty);
    if (anchor) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    nextFocus?.focus({ preventScroll: true });
  }

  function resetMessageWindow() {
    historyGeneration++;
    for (const id of rows.keys()) {
      releaseFiles(id);
      reactions.remove(id);
    }
    rows.clear();
    tombstones.clear();
    departedSequences.clear();
    oldest = Infinity;
    newest = 0;
    list.replaceChildren(empty);
  }

  function historyGrant(message) {
    return (message.deleted ? message.deleted.reason : message.envelope)?.historyGrant;
  }

  async function messageRow(message) {
    const author = message.author ?? t("Unknown", "Unbekannt");
    const date = new Date(message.at);
    const time = Number.isFinite(Number(date)) ? timeFormat.format(date) : "";
    const body = el("div", { class: "message-body" },
      el("div", { class: "message-meta" }, !message.deleted && personName(author),
        el("time", { datetime: time ? date.toISOString() : undefined, title: localizedTime(message.at) }, time)));
    let fileView;
    let reactionKey;
    let actions;
    const cryptoScope = message.cryptoChannelId ?? channel.id;
    if (message.deleted) {
      body.append(await deletionNote(message, author));
    } else {
      const own = context.user?.id === message.author?.id;
      if (own || edit) {
        const remove = button(t("Delete", "Löschen"), () => confirmRemoval(message, own), { class: "ghost message-delete",
          "aria-label": own ? t("Delete your message", "Eigene Nachricht löschen")
            : t("Delete message from {name}", "Nachricht von {name} löschen", { name: author.displayName }) });
        const move = !context.direct && context.moveDestinations?.().length &&
          button(t("Move", "Verschieben"), () => confirmMove(message), { class: "ghost message-move", "aria-haspopup": "dialog",
            "aria-label": t("Move message from {name}", "Nachricht von {name} verschieben", { name: author.displayName }) });
        actions = el("div", { class: "message-actions" }, move || null, remove);
      }
      try {
        const result = await ClubCrypto.openMessage(cryptoScope, message.id, message.envelope, channel.id);
        if (!result) {
          body.append(el("p", { class: "subtle" }, t("Your account does not have a key for this message.", "Für diese Nachricht ist auf deinem Konto kein Schlüssel verfügbar.")));
        } else {
          reactionKey = result.key;
          const text = result.content?.text;
          if (typeof text === "string" && text) body.append(...messageText(result.content, mentionDirectory).filter(Boolean));
          const attachments = normalizeAttachments(result.content?.attachments);
          if (attachments.length) {
            fileView = { controller: new AbortController() };
            const fileSignal = AbortSignal.any([signal, fileView.controller.signal]);
            fileView.attachments = attachments.map(attachment => renderAttachment(fileSignal, attachment, result.key, fileEndpoint, retainAttachment));
            body.append(...fileView.attachments.map(attachment => attachment.node));
          }
        }
      } catch {
        body.append(el("p", { class: "error" }, t("This message could not be decrypted.", "Diese Nachricht konnte nicht entschlüsselt werden.")));
      }
    }
    const row = el("li", { class: "message-row", "data-message-id": message.id, "data-sequence": message.seq,
      "data-author-id": !message.deleted && message.author?.id, "data-deleted": Boolean(message.deleted),
      "data-reason-granted": Boolean(message.deleted?.reason?.historyGrant),
      "data-history-grant-revision": historyGrant(message)?.revision,
      tabindex: "-1", "data-sent-at": date.getTime() }, personMark(author), body, actions);
    return { row, fileView, reactionKey, reactionMount: body, cryptoScope };
  }

  async function addMessages(messages, { olderBatch = false, keepPosition = false } = {}) {
    const generation = historyGeneration;
    const canRender = message => {
      const current = rows.get(message.id);
      const sequence = Number(message.seq);
      const currentSequence = Number(current?.dataset.sequence ?? 0);
      if (sequence <= (departedSequences.get(message.id) ?? 0) || sequence < currentSequence) return false;
      const revision = historyGrant(message)?.revision;
      const newerGrant = Number.isSafeInteger(revision) && revision > Number(current?.dataset.historyGrantRevision ?? 0);
      if (message.deleted) {
        return !current?.hasAttribute("data-deleted") || newerGrant ||
          Boolean(message.deleted.reason?.historyGrant && !current.hasAttribute("data-reason-granted"));
      }
      return !tombstones.has(message.id) && (!current || sequence > currentSequence || newerGrant);
    };
    for (const message of messages) if (message?.deleted) tombstones.add(message.id);
    const incoming = messages.filter(msg => msg && canRender(msg) && Number.isSafeInteger(Number(msg.seq)));
    if (!incoming.length) return;
    const elements = await Promise.all(incoming.map(async msg => [msg, await messageRow(msg)]));
    if (signal.aborted || generation !== historyGeneration) return;
    const wasNearEnd = list.scrollHeight - list.clientHeight - list.scrollTop < 64;
    const preservedHeight = list.scrollHeight;
    const preservedScroll = list.scrollTop;
    const viewTop = keepPosition ? list.getBoundingClientRect().top : 0;
    const anchor = keepPosition && Array.from(list.children).find(row =>
      row !== empty && row.getBoundingClientRect().bottom > viewTop);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    empty.remove();
    for (const [msg, { row, fileView, reactionKey, reactionMount, cryptoScope }] of elements) {
      if (!canRender(msg)) continue;
      const previous = rows.get(msg.id);
      const sequence = Number(msg.seq);
      const sameSlot = sequence === Number(previous?.dataset.sequence);
      const before = sameSlot ? previous : Array.from(list.children).find(child => Number(child.dataset.sequence) > sequence);
      const previousNext = !sameSlot && previous?.nextElementSibling;
      list.insertBefore(row, before ?? null);
      if (previous) {
        releaseFiles(msg.id);
        reactions.remove(msg.id);
        const hadFocus = previous.contains(document.activeElement);
        previous.remove();
        if (hadFocus) row.focus({ preventScroll: true });
      } else {
        oldest = Math.min(oldest, sequence);
      }
      updateMessageGroup(previousNext);
      updateMessageGroup(row);
      updateMessageGroup(row.nextElementSibling);
      rows.set(msg.id, row);
      if (reactionKey) reactions.track(msg.id, reactionKey, row, reactionMount, cryptoScope);
      if (fileView) {
        fileViews.set(msg.id, fileView);
        for (const attachment of fileView.attachments) {
          attachmentJobs.set(attachment.node, attachment);
          fileObserver.observe(attachment.node);
        }
      }
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
      const generation = historyGeneration;
      const batch = await api(messageEndpoint + "?before=" + first, { signal });
      if (generation !== historyGeneration) return;
      await addMessages(batch.messages ?? [], { olderBatch: true });
      if (generation !== historyGeneration) return;
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
      let fullPage = !initialized || (newest === 0 && rows.size === 0);
      const changes = new URLSearchParams({ after: newest, deletionsAfter: deletionVersion });
      if (!context.direct) changes.set("movesAfter", movementVersion);
      let result = await api(messageEndpoint + (fullPage ? "" : "?" + changes), { signal });
      if (result.movesReset && !signal.aborted) {
        result = await api(messageEndpoint, { signal });
        if (signal.aborted) return;
        resetMessageWindow();
        fullPage = true;
      }
      if (signal.aborted) return;
      const messages = result.messages ?? [];
      recipients = result.recipients ?? [];
      removeMovedMessages(result.moves ?? []);
      if (Number.isSafeInteger(result.nextMovementVersion)) movementVersion = result.nextMovementVersion;
      const deletions = result.deletions ?? [];
      for (const message of deletions) tombstones.add(message.id);
      const visibleDeletions = deletions.filter(message => rows.has(message.id) || message.seq >= oldest);
      await addMessages(visibleDeletions, { keepPosition: true });
      if (visibleDeletions.length < deletions.length) older.hidden = false;
      if (Number.isSafeInteger(result.nextDeletionVersion)) deletionVersion = result.nextDeletionVersion;
      if (result.moreDeletions || result.moreMoves) delay = 1000;
      await addMessages(messages);
      if (signal.aborted) return;
      for (const msg of messages) newest = Math.max(newest, Number(msg.seq) || 0);
      const revision = Number.isSafeInteger(result.historyVersion) ? result.historyVersion : 0;
      if (fullPage) {
        historyVersion = revision;
        deletionVersion = Number.isSafeInteger(result.deletionVersion) ? result.deletionVersion : 0;
        movementVersion = Number.isSafeInteger(result.movementVersion) ? result.movementVersion : 0;
        older.hidden = !result.more;
        initialized = true;
        empty.textContent = t("No messages yet.", "Noch keine Nachrichten.");
        list.setAttribute("aria-live", "polite");
        updateSend();
      } else if (revision > historyVersion) {
        if (await loadGrantedHistory()) delay = 1000;
      }
      setConnection("");
      if (context.direct) requestAnimationFrame(reportRead);
    } catch (error) {
      if (!signal.aborted) {
        setConnection(error.status === 403 ? t("You no longer have access to this chat.", "Du hast keinen Zugriff mehr auf diesen Chat.") : t("Reconnecting to the chat.", "Der Chat wird gerade neu verbunden."), "error");
        if (error.status === 403 || error.status === 404) {
          input.disabled = true;
          updateSend();
          (context.direct?.onUnavailable ?? context.refresh)();
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
    fileObserver.disconnect();
    for (const id of fileViews.keys()) releaseFiles(id);
  }, { once: true });

  const pane = el("section", { class: "panel conversation" },
    el("div", { class: "conversation-heading section-heading" },
      el("div", { class: "stack chat-title" }, el("h2", {}, context.direct ? context.direct.name : "# " + channel.title),
        el("span", { class: "tag" }, t("End-to-end encrypted", "Ende-zu-Ende-verschlüsselt"))),
      edit),
    el("div", { class: "chat-controls stack" }, older, connection),
    list,
    composer, context.direct && unavailable);
  if (context.direct) {
    updateDirect(canSend);
    context.direct.events.addEventListener("change", event => updateDirect(event.detail), { signal });
    list.addEventListener("scroll", reportRead, { signal, passive: true });
    document.addEventListener("visibilitychange", reportRead, { signal });
  }
  pane.addEventListener("open-message", event => requestMessage(event.detail?.messageId), { signal });
  requestMessage(context.messageId);
  poll();
  return pane;
}
