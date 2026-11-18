import { t } from "./i18n.js";
import { button, el } from "./ui.js";

let nextMessageText = 0;

export function textPrefix(text, characterLimit, lineLimit = Infinity) {
  let end = 0;
  let characters = 0;
  let lines = 1;
  for (const point of text) {
    if (++characters > characterLimit || (point === "\n" && ++lines > lineLimit)) break;
    end += point.length;
  }
  return text.slice(0, end);
}

export function foldMessageText(text, render, boundary = (_text, end) => end) {
  const preview = textPrefix(text, 420, 6);
  if (preview.length === text.length) return render(text, false);
  const id = "folded-message-text-" + (++nextMessageText);
  const short = el("div", { class: "message-text-copy" }, render(text.slice(0, boundary(text, preview.length)), true));
  const full = el("div", { id, class: "message-text-copy", hidden: true }, render(text, false));
  const toggle = button(t("More…", "Mehr …"), () => {
    const expanded = full.hidden;
    full.hidden = !expanded;
    short.hidden = expanded;
    toggle.textContent = expanded ? t("Less", "Weniger") : t("More…", "Mehr …");
    toggle.setAttribute("aria-expanded", String(expanded));
  }, { class: "ghost message-text-toggle", "aria-controls": id, "aria-expanded": "false" });
  return [el("div", { class: "message-text-fold" }, short, full, toggle)];
}
