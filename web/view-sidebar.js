import { t } from "./i18n.js";

const preference = "rooms-view-sidebar-width";
let nextId = 0;

export function mountViewSidebar(layout, panel, actions, signal) {
  panel.id ||= "view-sidebar-" + ++nextId;
  const sidebar = layout.ownerDocument.createElement("div");
  sidebar.className = "view-sidebar";
  sidebar.innerHTML = `
    <div class="view-sidebar-rail">
      <button type="button" class="button view-sidebar-toggle"><span class="view-sidebar-chevron" aria-hidden="true"></span></button>
      <div class="view-sidebar-divider" role="separator" tabindex="0" aria-orientation="vertical"></div>
    </div>
    <div class="view-sidebar-clip"></div>`;
  const toggle = sidebar.querySelector(".view-sidebar-toggle");
  const rail = sidebar.querySelector(".view-sidebar-rail");
  const divider = sidebar.querySelector(".view-sidebar-divider");
  toggle.setAttribute("aria-controls", panel.id);
  divider.setAttribute("aria-controls", panel.id);
  sidebar.querySelector(".view-sidebar-clip").append(panel);
  layout.append(sidebar);
  let width;
  let drag;
  try {
    const saved = Number(localStorage.getItem(preference));
    if (saved > 0 && saved < 100) {
      width = saved;
      layout.style.setProperty("--view-sidebar-preferred", saved + "%");
    }
  } catch { /* Storage may be unavailable. */ }

  function rememberWidth() {
    if (!width) return;
    try { localStorage.setItem(preference, String(width)); } catch { /* Storage is optional. */ }
  }

  function bounds() {
    if (!divider.offsetWidth || !layout.clientWidth) return null;
    const style = getComputedStyle(sidebar);
    const total = layout.clientWidth;
    const min = parseFloat(getComputedStyle(panel).minInlineSize) + divider.offsetWidth + parseFloat(style.columnGap);
    const max = Math.max(min, total * parseFloat(style.getPropertyValue("--view-sidebar-max-ratio")));
    return { total, min, max, current: sidebar.getBoundingClientRect().width };
  }

  function updateValue() {
    const size = bounds();
    if (!size) return;
    const percent = pixels => String(Math.round(100 * pixels / size.total));
    divider.setAttribute("aria-valuemin", percent(size.min));
    divider.setAttribute("aria-valuemax", percent(size.max));
    const value = percent(Math.max(size.min, Math.min(size.max, size.current)));
    divider.setAttribute("aria-valuenow", value);
    divider.setAttribute("aria-valuetext", value + "%");
  }

  function resize(pixels, { min, max, total }) {
    width = Math.round(10000 * Math.max(min, Math.min(max, pixels)) / total) / 100;
    layout.style.setProperty("--view-sidebar-preferred", width + "%");
  }

  function finishDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const { changed } = drag;
    drag = null;
    layout.removeAttribute("data-resizing-view-sidebar");
    if (changed) rememberWidth();
  }

  function updateLabels() {
    const collapsed = sidebar.hasAttribute("data-collapsed");
    const label = collapsed ? t("Show sidebar", "Seitenleiste ausklappen") : t("Hide sidebar", "Seitenleiste einklappen");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = label;
    const resizeLabel = t("Resize sidebar", "Breite der Seitenleiste ändern");
    divider.setAttribute("aria-label", resizeLabel);
    divider.title = resizeLabel;
  }

  function setCollapsed(collapsed) {
    if (collapsed === sidebar.hasAttribute("data-collapsed")) return;
    const focused = panel.ownerDocument.activeElement;
    const restoreFocus = focused === toggle || collapsed && (focused === divider || panel.contains(focused));
    if (collapsed) finishDrag();
    sidebar.toggleAttribute("data-collapsed", collapsed);
    panel.inert = collapsed;
    (collapsed ? actions : rail).append(toggle);
    updateLabels();
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", () => setCollapsed(!sidebar.hasAttribute("data-collapsed")), { signal });
  divider.addEventListener("pointerdown", event => {
    const size = bounds();
    if (!size || drag || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: size.current, changed: false };
    layout.setAttribute("data-resizing-view-sidebar", "");
  }, { signal });
  divider.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId || event.clientX === drag.x && !drag.changed) return;
    const size = bounds();
    if (!size) return finishDrag(event);
    resize(drag.width + drag.x - event.clientX, size);
    drag.changed = true;
  }, { signal });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    divider.addEventListener(type, finishDrag, { signal });
  }
  divider.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey || drag) return;
    const size = bounds();
    if (!size) return;
    const current = width ? Math.max(size.min, Math.min(size.max, width * size.total / 100)) : size.current;
    let next;
    if (event.key === "Home") next = size.min;
    else if (event.key === "End") next = size.max;
    else if (event.key === "ArrowLeft") next = current + 16;
    else if (event.key === "ArrowRight") next = current - 16;
    else return;
    event.preventDefault();
    resize(next, size);
    rememberWidth();
  }, { signal });

  const observer = new ResizeObserver(updateValue);
  observer.observe(layout);
  observer.observe(sidebar);
  signal.addEventListener("abort", () => {
    finishDrag();
    observer.disconnect();
  }, { once: true });
  updateLabels();
  return { open: () => setCollapsed(false), updateLabels };
}
