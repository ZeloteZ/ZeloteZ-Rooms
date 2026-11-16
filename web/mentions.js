import { api, el, identifier, topicHref } from "./ui.js";
import { t } from "./i18n.js";

const kinds = new Set(["user", "room", "channel"]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const maxOptions = 9;
const maxMentions = 48;
const maxUserMentions = 12;
const refreshInterval = 20000;
const roomPlaceholder = "@…";
let nextPopup = 0;

function validId(value) {
  return typeof value === "string" && uuid.test(value);
}

function mentionKey(kind, id) {
  return kind + ":" + id;
}

function kindName(kind) {
  if (kind === "user") return t("Person", "Person");
  if (kind === "room") return t("Room", "Raum");
  return t("Channel", "Kanal");
}

export function createMentionDirectory({ signal, channelId, streamId, scope }) {
  const endpoint = "mentions?" + (streamId ? "streamId=" + identifier(streamId) : "channelId=" + identifier(channelId));
  const events = new EventTarget();
  let entries = new Map();
  let pending;
  let completedAt = 0;

  function paint(token) {
    const { mentionKey: key, mentionKind: kind, mentionFallback: fallback } = token.dataset;
    const entry = entries.get(key);
    if (entry) {
      token.textContent = "@" + entry.label;
      if (entry.detail) token.title = entry.detail;
      else token.removeAttribute("title");
      if (entry.href) token.setAttribute("href", entry.href);
      return;
    }
    token.removeAttribute("href");
    token.removeAttribute("title");
    token.textContent = fallback || (kind === "room"
      ? t("@Unavailable room", "@Raum nicht verfügbar")
      : t("@Unavailable channel", "@Kanal nicht verfügbar"));
  }

  function update() {
    for (const token of scope?.querySelectorAll("[data-mention-key]") ?? []) paint(token);
    events.dispatchEvent(new Event("change"));
  }

  async function readDirectory() {
    const collected = new Map();
    const loadedCursors = new Set();
    let cursor;
    do {
      const { suggestions, next } = await api(endpoint + (cursor ? "&after=" + encodeURIComponent(cursor) : ""), { signal });
      if (signal?.aborted) return;
      for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
        if (!suggestion || typeof suggestion !== "object") continue;
        const { kind, id, label, roomId, detail } = suggestion;
        if (!kinds.has(kind) || !validId(id) || typeof label !== "string" || !label.trim()) continue;
        if (kind === "channel" && !validId(roomId)) continue;
        const href = kind === "room" ? topicHref(id) : kind === "channel" ? topicHref(roomId, id) : null;
        collected.set(mentionKey(kind, id), { kind, id, label, detail: typeof detail === "string" ? detail : "", href });
      }
      cursor = typeof next === "string" && !loadedCursors.has(next) ? next : null;
      if (cursor) loadedCursors.add(cursor);
    } while (cursor);
    entries = collected;
  }

  function refresh(force = false) {
    if (signal?.aborted) return Promise.resolve();
    if (pending) return pending;
    if (!force && Date.now() - completedAt < refreshInterval) return Promise.resolve();
    pending = readDirectory().catch(() => {
      if (!signal?.aborted) entries = new Map();
    }).finally(() => {
      pending = undefined;
      completedAt = Date.now();
      if (signal?.aborted) return;
      update();
    });
    return pending;
  }

  function tokenFor(mark, fallback) {
    const key = mentionKey(mark.kind, mark.id);
    const token = el(mark.kind === "user" ? "span" : "a", {
      class: "message-mention",
      "data-mention-key": key,
      "data-mention-kind": mark.kind,
      "data-mention-fallback": mark.kind === "user" ? fallback : undefined,
    });
    paint(token);
    void refresh().then(() => {
      if (!signal?.aborted) paint(token);
    });
    if (mark.kind !== "user") {
      token.addEventListener("click", async event => {
        if (!token.hasAttribute("href") || event.defaultPrevented || event.metaKey || event.ctrlKey ||
            event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        await refresh(true);
        const href = entries.get(key)?.href;
        if (!signal?.aborted && href) location.hash = href;
      }, { signal });
    }
    return token;
  }

  return {
    refresh,
    tokenFor,
    suggestions: () => entries.values(),
    pending: () => Boolean(pending),
    onChange: callback => events.addEventListener("change", callback, { signal }),
  };
}

function normalized(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function choices(directory, query, userIds) {
  const needle = normalized(query).trim();
  const words = needle.split(/\s+/u).filter(Boolean);
  const matches = [];
  for (const suggestion of directory.suggestions()) {
    if (suggestion.kind === "user" && userIds.size >= maxUserMentions && !userIds.has(suggestion.id)) continue;
    const label = normalized(suggestion.label);
    const fullText = label + " " + normalized(suggestion.detail);
    if (words.some(word => !fullText.includes(word))) continue;
    const rank = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : 3;
    matches.push({ suggestion, rank });
  }
  matches.sort((one, other) => one.rank - other.rank || one.suggestion.label.localeCompare(other.suggestion.label));
  if (words.length) return matches.slice(0, maxOptions).map(({ suggestion }) => suggestion);
  const counts = new Map();
  return matches.filter(({ suggestion }) => {
    const count = counts.get(suggestion.kind) ?? 0;
    counts.set(suggestion.kind, count + 1);
    return count < maxOptions / kinds.size;
  }).map(({ suggestion }) => suggestion);
}

function updateMarks(previous, changed, marks) {
  if (previous === changed) return marks;
  let start = 0;
  const shared = Math.min(previous.length, changed.length);
  while (start < shared && previous[start] === changed[start]) start++;
  let suffix = 0;
  while (suffix < shared - start &&
      previous[previous.length - suffix - 1] === changed[changed.length - suffix - 1]) suffix++;
  const beforeEnd = previous.length - suffix;
  const shift = changed.length - previous.length;
  return marks.flatMap(mark => {
    const moved = mark.end <= start ? mark
      : mark.start >= beforeEnd ? { ...mark, start: mark.start + shift, end: mark.end + shift } : null;
    return moved && !/[\p{L}\p{N}\p{M}_@]/u.test(changed[moved.start - 1] ?? "") &&
      !/[\p{L}\p{N}\p{M}_@]/u.test(changed[moved.end] ?? "") ? [moved] : [];
  });
}

function queryAt(input, marks) {
  if (input.disabled || input.readOnly || input.selectionStart !== input.selectionEnd) return null;
  const end = input.selectionEnd;
  if (!Number.isInteger(end)) return null;
  const left = input.value.slice(0, end);
  const start = left.lastIndexOf("@");
  if (start < 0 || /[\p{L}\p{N}\p{M}_./@-]/u.test(left[start - 1] ?? "")) return null;
  if (marks.some(mark => mark.start === start)) return null;
  const query = left.slice(start + 1);
  if (query.length > 64 || /[\n<>]/u.test(query)) return null;
  return { start, end, query };
}

export function mentionComposer(input, directory, { signal } = {}) {
  const popupId = "mention-choices-" + ++nextPopup;
  const list = el("div", { class: "mention-choices", hidden: true });
  const hint = el("p", { class: "mention-choices-hint", role: "status", hidden: true });
  const options = el("ul", { id: popupId, role: "listbox", "aria-label": t("Mention suggestions", "Vorschläge für Erwähnungen") });
  list.append(hint, options);
  const node = el("div", { class: "mention-field" }, input, list);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", popupId);
  let previous = input.value;
  let marks = [];
  let range;
  let dismissed;
  let composing = false;
  let available = [];
  let active = 0;
  let keyboardSelected = false;

  function syncDraft() {
    marks = updateMarks(previous, input.value, marks);
    previous = input.value;
  }

  function hide() {
    list.hidden = true;
    input.removeAttribute("aria-activedescendant");
  }

  function selectIndex(index) {
    keyboardSelected = true;
    active = index;
    for (const [position, option] of Array.from(options.children).entries()) {
      option.setAttribute("aria-selected", String(position === active));
    }
    const option = options.children[active];
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function paint() {
    if (!range || composing || document.activeElement !== input) return hide();
    const userIds = new Set(marks.filter(mark => mark.kind === "user").map(mark => mark.id));
    const selected = available[active];
    available = choices(directory, range.query, userIds);
    const selectedIndex = keyboardSelected
      ? available.findIndex(option => option.id === selected?.id && option.kind === selected?.kind) : -1;
    active = Math.max(0, selectedIndex);
    list.hidden = false;
    hint.hidden = available.length > 0;
    if (!hint.hidden) hint.textContent = directory.pending()
      ? t("Loading suggestions…", "Vorschläge werden geladen …")
      : t("No matching people, rooms or channels.", "Keine passenden Personen, Räume oder Kanäle.");
    options.replaceChildren(...available.map((entry, index) => {
      const option = el("li", { id: popupId + "-" + index, role: "option", "aria-selected": String(index === active) },
        el("span", { class: "mention-choice-name" }, entry.label),
        el("span", { class: "mention-choice-kind" }, kindName(entry.kind)),
        entry.detail && el("span", { class: "mention-choice-detail" }, entry.detail));
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("click", () => choose(entry));
      return option;
    }));
    if (available.length) input.setAttribute("aria-activedescendant", options.children[active].id);
    else input.removeAttribute("aria-activedescendant");
  }

  function readRange() {
    syncDraft();
    const next = composing || marks.length >= maxMentions ? null : queryAt(input, marks);
    if (next?.start !== range?.start || next?.end !== range?.end || next?.query !== range?.query) keyboardSelected = false;
    range = next;
    if (range && dismissed === range.start + ":" + range.end + ":" + range.query) range = null;
    if (range) void directory.refresh();
    paint();
  }

  function choose(entry) {
    if (!range || !entry) return;
    const { start, end } = range;
    const label = "@" + entry.label;
    const following = input.value.slice(end);
    const tail = !following || !/^\s/u.test(following) ? " " : "";
    const replacement = label + tail;
    if (input.maxLength > 0 && input.value.length - (end - start) + replacement.length > input.maxLength) return;
    input.setRangeText(replacement, start, end, "end");
    syncDraft();
    marks.push({ kind: entry.kind, id: entry.id, start, end: start + label.length });
    marks.sort((one, other) => one.start - other.start);
    range = null;
    hide();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  input.addEventListener("input", () => {
    dismissed = null;
    readRange();
  }, { signal });
  for (const action of ["focus", "click", "select"]) input.addEventListener(action, readRange, { signal });
  input.addEventListener("blur", hide, { signal });
  input.addEventListener("compositionstart", () => { composing = true; hide(); }, { signal });
  input.addEventListener("compositionend", () => { composing = false; readRange(); }, { signal });
  input.addEventListener("keyup", event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) readRange();
  }, { signal });
  input.addEventListener("keydown", event => {
    if (list.hidden || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismissed = range.start + ":" + range.end + ":" + range.query;
      range = null;
      hide();
      return;
    }
    if (!available.length || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const move = event.key === "ArrowDown" ? 1 : -1;
      selectIndex((active + move + available.length) % available.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(available[active]);
    }
  }, { signal });
  directory.onChange(paint);

  function finish() {
    syncDraft();
    const start = previous.length - previous.trimStart().length;
    const end = previous.trimEnd().length;
    let source = start;
    let text = "";
    const mentions = [];
    const users = new Set();
    for (const mark of marks) {
      if (mark.start < source || mark.end > end) continue;
      text += previous.slice(source, mark.start);
      const offset = text.length;
      text += mark.kind === "user" ? previous.slice(mark.start, mark.end) : roomPlaceholder;
      mentions.push({ kind: mark.kind, id: mark.id, start: offset, end: text.length });
      if (mark.kind === "user") users.add(mark.id);
      source = mark.end;
    }
    text += previous.slice(source, end);
    return { text, mentions, mentionedUserIds: [...users] };
  }

  function reset() {
    previous = input.value;
    marks = [];
    range = null;
    dismissed = null;
    hide();
  }

  return { node, finish, reset };
}

export function renderMentionText(content, directory, renderPlain = value => [value]) {
  const text = typeof content?.text === "string" ? content.text : "";
  const references = Array.isArray(content?.mentions) ? content.mentions.slice(0, maxMentions) : [];
  let offset = 0;
  const nodes = [];
  for (const mark of references) {
    if (!mark || !kinds.has(mark.kind) || !validId(mark.id) || !Number.isInteger(mark.start) ||
        !Number.isInteger(mark.end) || mark.start < offset || mark.end > text.length || mark.end - mark.start < 2 ||
        text[mark.start] !== "@") continue;
    if (mark.kind !== "user" && text.slice(mark.start, mark.end) !== roomPlaceholder) continue;
    nodes.push(...renderPlain(text.slice(offset, mark.start)), directory.tokenFor(mark, text.slice(mark.start, mark.end)));
    offset = mark.end;
  }
  nodes.push(...renderPlain(text.slice(offset)));
  return nodes;
}
