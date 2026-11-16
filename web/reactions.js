import { t } from "./i18n.js";
import { api, button, el, identifier, notify } from "./ui.js";

const emojiNames = new Map([
  ["👍", ["Thumbs up", "Daumen hoch"]],
  ["❤️", ["Heart", "Herz"]],
  ["😂", ["Laughing", "Lachen"]],
  ["🎉", ["Celebrate", "Feiern"]],
  ["🔥", ["Fire", "Feuer"]],
  ["👀", ["Eyes", "Augen"]],
  ["🙌", ["Hands up", "Hände hoch"]],
  ["👏", ["Applause", "Applaus"]],
  ["💯", ["One hundred", "Hundert"]],
  ["✨", ["Sparkles", "Glitzern"]],
  ["✅", ["Check", "Haken"]],
  ["🤝", ["Handshake", "Handschlag"]],
  ["😄", ["Smile", "Lächeln"]],
  ["😍", ["Love it", "Begeistert"]],
  ["🤣", ["Rolling with laughter", "Vor Lachen rollen"]],
  ["😎", ["Cool", "Cool"]],
  ["🤔", ["Thinking", "Nachdenken"]],
  ["😮", ["Surprised", "Überrascht"]],
  ["😢", ["Sad", "Traurig"]],
  ["🙏", ["Thanks", "Danke"]],
  ["💪", ["Strong", "Stark"]],
  ["👎", ["Thumbs down", "Daumen runter"]],
  ["💜", ["Purple heart", "Violettes Herz"]],
  ["🚀", ["Rocket", "Rakete"]],
]);
const pickerColumns = 6;
const batchSize = 40;
const refreshInterval = 3000;

function userList(users) {
  const names = [...users.values()].map(user => user.displayName);
  const visible = names.slice(0, 8).join(", ");
  return names.length > 8 ? t("{names} and {count} more", "{names} und {count} weitere", {
    names: visible, count: names.length - 8,
  }) : visible;
}

function addReaction(groups, emoji, reaction) {
  let users = groups.get(emoji);
  if (!users) {
    users = new Map();
    groups.set(emoji, users);
  }
  users.set(reaction.userId, reaction);
}

export function createReactions({ endpoint, scope, user, signal, scroll }) {
  if (!user?.id || signal.aborted) return { track() {}, remove() {} };
  const base = endpoint + "/reactions";
  const entries = new Map();
  const observed = new WeakMap();
  const visible = new Set();
  const addLabel = t("Add reaction", "Reaktion hinzufügen");
  const options = [...emojiNames].map(([emoji, names]) => button(emoji, () => {
    const entry = picked;
    closePicker();
    if (entry) void toggle(entry, emoji);
  }, { class: "reaction-option", "aria-label": t(...names), title: t(...names), "aria-pressed": "false" }));
  const grid = el("div", { class: "reaction-picker-options" }, options);
  const picker = el("dialog", { class: "reaction-picker", "aria-label": addLabel }, grid);
  document.body.append(picker);
  let picked;
  let timer;
  let polling = false;
  let refreshPending = false;

  function positionPicker() {
    if (!picked || !picker.open) return;
    const anchor = picked.trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const gap = 8;
    picker.style.maxWidth = Math.max(0, width - gap * 2) + "px";
    picker.style.maxHeight = Math.max(0, height - gap * 2) + "px";
    const { offsetHeight: panelHeight, offsetWidth: panelWidth } = picker;
    const above = anchor.top - panelHeight - gap;
    const below = anchor.bottom + gap;
    const y = above >= top + gap ? above : below;
    picker.style.left = Math.max(left + gap, Math.min(anchor.left, left + width - panelWidth - gap)) + "px";
    picker.style.top = Math.max(top + gap, Math.min(y, top + height - panelHeight - gap)) + "px";
  }

  function clearPicker() {
    picked?.trigger.setAttribute("aria-expanded", "false");
    picked = undefined;
  }

  function closePicker() {
    if (picker.open) picker.close();
    clearPicker();
  }

  function paintPicker(entry) {
    let index = 0;
    for (const emoji of emojiNames.keys()) {
      options[index++].setAttribute("aria-pressed", String(Boolean(entry.groups.get(emoji)?.has(user.id))));
    }
  }

  function openPicker(entry) {
    if (entry.busy || picker.open || signal.aborted) return;
    picked = entry;
    entry.trigger.focus({ preventScroll: true });
    entry.trigger.setAttribute("aria-expanded", "true");
    paintPicker(entry);
    picker.showModal();
    positionPicker();
    options[0].focus({ preventScroll: true });
  }

  picker.addEventListener("close", () => { if (!picker.open) clearPicker(); }, { signal });
  picker.addEventListener("click", event => { if (event.target === picker) closePicker(); }, { signal });
  picker.addEventListener("keydown", event => {
    const index = options.indexOf(event.target);
    if (index < 0) return;
    const steps = { ArrowLeft: index - 1, ArrowRight: index + 1,
      ArrowUp: index - pickerColumns, ArrowDown: index + pickerColumns, Home: 0, End: options.length - 1 };
    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    options[(steps[event.key] + options.length) % options.length].focus({ preventScroll: true });
  }, { signal });
  scroll.addEventListener("scroll", positionPicker, { passive: true, signal });
  window.addEventListener("resize", positionPicker, { signal });
  window.visualViewport?.addEventListener("resize", positionPicker, { signal });
  window.visualViewport?.addEventListener("scroll", positionPicker, { signal });

  function paint(entry) {
    for (const [emoji, chip] of entry.chips) {
      if (entry.groups.get(emoji)?.size) continue;
      if (document.activeElement === chip) entry.trigger.focus({ preventScroll: true });
      chip.remove();
      entry.chips.delete(emoji);
    }
    for (const [emoji, users] of entry.groups) {
      if (!users.size) continue;
      let chip = entry.chips.get(emoji);
      if (!chip) {
        chip = button([
          el("span", { "aria-hidden": "true" }, emoji),
          el("span", { class: "reaction-count", "aria-hidden": "true" }),
        ], () => toggle(entry, emoji), { class: "reaction-chip" });
        entry.chips.set(emoji, chip);
        entry.bar.insertBefore(chip, entry.trigger);
      }
      const count = String(users.size);
      const label = users.size === 1 ? t("{name}, 1 reaction", "{name}, 1 Reaktion", { name: t(...emojiNames.get(emoji)) })
        : t("{name}, {count} reactions", "{name}, {count} Reaktionen", { name: t(...emojiNames.get(emoji)), count });
      if (chip.lastChild.textContent !== count) chip.lastChild.textContent = count;
      chip.setAttribute("aria-pressed", String(users.has(user.id)));
      chip.setAttribute("aria-label", label);
      chip.title = userList(users);
    }
    if (picked === entry) paintPicker(entry);
  }

  function setBusy(entry, value) {
    entry.busy = value;
    entry.bar.setAttribute("aria-busy", String(value));
    for (const control of entry.bar.children) control.setAttribute("aria-disabled", String(value));
  }

  async function toggle(entry, emoji) {
    if (entry.busy || signal.aborted || entries.get(entry.id) !== entry) return;
    setBusy(entry, true);
    ++entry.revision;
    const own = entry.groups.get(emoji)?.get(user.id);
    try {
      const sealed = own ? null : await ClubCrypto.sealReaction(entry.key, entry.scope, entry.id, user.id, emoji);
      const reactionId = own?.id ?? sealed.id;
      await api(base + "/" + identifier(entry.id) + "/" + identifier(reactionId), own
        ? { method: "DELETE", signal: entry.signal }
        : { method: "PUT", body: { nonce: sealed.nonce, body: sealed.body }, signal: entry.signal });
      if (entry.signal.aborted) return;
      if (own) entry.groups.get(emoji).delete(user.id);
      else addReaction(entry.groups, emoji, {
        userId: user.id, id: reactionId, displayName: user.displayName || user.username || t("You", "Du"),
      });
      paint(entry);
    } catch (error) {
      if (!entry.signal.aborted) notify(error.message || t("The reaction couldn’t be saved.", "Die Reaktion konnte nicht gespeichert werden."));
    } finally {
      setBusy(entry, false);
    }
  }

  function schedule(delay) {
    if (signal.aborted || document.hidden || !visible.size) return;
    if (polling) {
      refreshPending = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }

  async function fetchBatch(batch) {
    const snapshots = new Map(batch.map(entry => [entry.id, { entry, revision: entry.revision, groups: new Map() }]));
    const query = new URLSearchParams({ ids: [...snapshots.keys()].join(",") });
    const { reactions } = await api(base + "?" + query, { signal });
    if (!Array.isArray(reactions)) return;
    await Promise.all(reactions.map(async reaction => {
      const snapshot = snapshots.get(reaction.messageId);
      if (!snapshot || typeof reaction.userId !== "string" || typeof reaction.displayName !== "string") return;
      try {
        const emoji = await ClubCrypto.openReaction(snapshot.entry.key, snapshot.entry.scope, reaction.messageId, reaction);
        if (emojiNames.has(emoji)) addReaction(snapshot.groups, emoji, reaction);
      } catch {
        // Leave unreadable encrypted reactions out of the count.
      }
    }));
    for (const { entry, revision, groups } of snapshots.values()) {
      if (entry.signal.aborted || entry.busy || entry.revision !== revision) continue;
      entry.groups = groups;
      paint(entry);
    }
  }

  async function poll() {
    if (signal.aborted || document.hidden || polling) return;
    polling = true;
    try {
      const current = [...visible];
      for (let index = 0; index < current.length && !signal.aborted; index += batchSize) {
        const batch = current.slice(index, index + batchSize).filter(entry => !entry.busy && !entry.signal.aborted);
        if (batch.length) await fetchBatch(batch);
      }
    } catch {
      // Keep the current counts during a failed refresh and retry on the next poll.
    } finally {
      polling = false;
      const delay = refreshPending ? 120 : refreshInterval;
      refreshPending = false;
      schedule(delay);
    }
  }

  const observer = new IntersectionObserver(changes => {
    let needsRefresh = false;
    for (const change of changes) {
      const entry = observed.get(change.target);
      if (!entry || entry.signal.aborted) continue;
      if (change.isIntersecting && !visible.has(entry)) {
        visible.add(entry);
        needsRefresh = true;
      } else if (!change.isIntersecting) visible.delete(entry);
    }
    if (needsRefresh) schedule(120);
  }, { root: scroll });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else schedule(120);
  }, { signal });

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (picked === entry) closePicker();
    entry.controller.abort();
    observer.unobserve(entry.row);
    observed.delete(entry.row);
    visible.delete(entry);
    entries.delete(id);
    entry.bar.remove();
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    observer.disconnect();
    closePicker();
    picker.remove();
    for (const entry of entries.values()) entry.controller.abort();
    entries.clear();
    visible.clear();
  }, { once: true });

  return {
    track(id, key, row, mount = row, messageScope = scope) {
      if (signal.aborted || entries.has(id)) return;
      const controller = new AbortController();
      const entry = { id, key, row, scope: messageScope, controller, signal: controller.signal,
        groups: new Map(), chips: new Map(), revision: 0, busy: false };
      entry.trigger = button(el("span", { "aria-hidden": "true" }, "+"), () => openPicker(entry),
        { class: "reaction-add", "aria-label": addLabel, title: addLabel, "aria-haspopup": "dialog", "aria-expanded": "false" });
      entry.bar = el("div", { class: "message-reactions", "aria-live": "off" }, entry.trigger);
      mount.append(entry.bar);
      entries.set(id, entry);
      observed.set(row, entry);
      observer.observe(row);
    },
    remove,
  };
}
