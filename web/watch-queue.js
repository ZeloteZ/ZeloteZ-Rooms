import { t } from "./i18n.js";

function item(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(className, action, text = "") {
  const node = item("button", "button " + className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

export function watchQueue({ add, remove, next } = {}) {
  const title = item("h2");
  const empty = item("p", "muted");
  const list = item("ol", "watch-queue-list");
  const feedback = item("p", "status");
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  const append = add && button("ghost", add);
  const skip = next && button("ghost", next);
  const actions = item("div", "inline watch-queue-actions", ...[append, skip].filter(Boolean));
  const node = item("section", "panel watch-queue", item("div", "section-heading watch-queue-heading", title, actions), empty, list, feedback);
  node.hidden = true;
  actions.hidden = true;
  let items = [];
  let canManage = false;
  let busy = false;
  let signature;

  function paint() {
    const label = t("Queue", "Warteschlange");
    title.textContent = label;
    node.setAttribute("aria-label", label);
    if (append) append.textContent = t("Add video", "Video hinzufügen");
    if (skip) skip.textContent = t("Next video", "Nächstes Video");
    empty.textContent = t("No videos queued.", "Keine Videos in der Warteschlange.");
    list.replaceChildren(...items.map(video => {
      const source = video.source === "youtube" ? "YouTube" : t("Local video", "Lokales Video");
      const name = video.title || (video.videoId ? source + " · " + video.videoId : source);
      const row = item("li", "", item("div", "watch-queue-entry", item("strong", "", name),
        item("span", "muted", video.state === "uploading" ? t("Uploading…", "Wird hochgeladen …") : source)));
      if (canManage && remove) {
        const control = button("ghost icon-button", () => remove(video.id), "×");
        control.disabled = busy;
        control.setAttribute("aria-label", t("Remove {name}", "{name} entfernen", { name }));
        row.append(control);
      }
      return row;
    }));
  }

  function update(nextItems, { visible, manage = false, pending = false }) {
    node.hidden = !visible;
    items = Array.isArray(nextItems) ? nextItems : [];
    canManage = manage;
    busy = pending;
    actions.hidden = !manage || !append;
    if (append) append.disabled = pending;
    if (skip) skip.disabled = pending || items[0]?.state !== "ready";
    empty.hidden = items.length > 0;
    const nextSignature = JSON.stringify([items, manage, pending]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      paint();
    }
  }

  paint();
  return { node, update, refreshLabels: paint, feedback };
}
