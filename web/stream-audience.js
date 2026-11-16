import { api, el, identifier, personName, status, tell } from "./ui.js";
import { t } from "./i18n.js";

export function renderStreamAudience({ signal }, streamId) {
  const viewTitle = t("Viewers", "Zuschauer");
  const list = el("ul", { class: "stream-viewers", "aria-label": t("Current viewers", "Aktuelle Zuschauer") });
  const viewerNote = status(t("Loading viewers …", "Zuschauer werden geladen …"));
  const count = el("span", { class: "tag", hidden: true });
  const node = el("section", { class: "panel stream-audience", "aria-label": viewTitle },
    el("div", { class: "section-heading" }, el("h2", {}, viewTitle), count), viewerNote, list);
  let timer;
  let previous;

  async function refresh() {
    try {
      const { viewers } = await api("streams/" + identifier(streamId) + "/audience", { signal });
      if (signal.aborted) return;
      const signature = JSON.stringify(viewers);
      if (signature !== previous) {
        previous = signature;
        list.replaceChildren(...viewers.map(viewer => el("li", {}, personName(viewer))));
      }
      count.hidden = false;
      count.textContent = String(viewers.length);
      tell(viewerNote, viewers.length ? "" : t("No one is watching yet.", "Gerade schaut niemand zu."));
    } catch (error) {
      if (signal.aborted) return;
      previous = undefined;
      list.replaceChildren();
      count.hidden = true;
      tell(viewerNote, error.status === 404
        ? t("The viewer list is unavailable for this stream.", "Zuschauerliste für diesen Stream nicht verfügbar.")
        : t("Reconnecting the viewer list …", "Zuschauerliste wird neu verbunden …"));
    }
    if (!signal.aborted) timer = setTimeout(refresh, 3000);
  }

  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  refresh();
  return node;
}
