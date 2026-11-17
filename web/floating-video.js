const inset = 8;
const minimum = { width: 294, height: 322 };
const initial = { width: 430, height: 356 };
const edges = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const sheets = ["styles.css", "watch-party.css", "guest.css", "floating-video.css"];
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

function bounds(content) {
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft ?? 0) + inset;
  const top = Math.max(content.getBoundingClientRect().top, viewport?.offsetTop ?? 0) + inset;
  const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 2 * inset;
  const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? document.documentElement.clientHeight) - inset;
  return { left, top, right: Math.max(left + 1, right), bottom: Math.max(top + 1, bottom) };
}

function fit(preferred, area) {
  const maxWidth = area.right - area.left;
  const maxHeight = area.bottom - area.top;
  const width = clamp(preferred?.width ?? initial.width, Math.min(minimum.width, maxWidth), maxWidth);
  const height = clamp(preferred?.height ?? initial.height, Math.min(minimum.height, maxHeight), maxHeight);
  return {
    x: clamp(preferred?.x ?? area.right - width, area.left, area.right - width),
    y: clamp(preferred?.y ?? area.bottom - height, area.top, area.bottom - height),
    width, height,
  };
}

function change(start, area, edge, dx, dy) {
  if (!edge) return fit({ ...start, x: start.x + dx, y: start.y + dy }, area);
  const width = Math.min(minimum.width, area.right - area.left);
  const height = Math.min(minimum.height, area.bottom - area.top);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const x = edge.includes("w") ? clamp(start.x + dx, area.left, right - width) : start.x;
  const y = edge.includes("n") ? clamp(start.y + dy, area.top, bottom - height) : start.y;
  return {
    x, y,
    width: (edge.includes("e") ? clamp(right + dx, x + width, area.right) : right) - x,
    height: (edge.includes("s") ? clamp(bottom + dy, y + height, area.bottom) : bottom) - y,
  };
}

export function mountFloatingVideo(panel, heading, caption, content, signal) {
  let preferred;
  const local = () => panel.ownerDocument === document;

  function place() {
    if (!local() || !panel.isConnected) return;
    const { x, y, width, height } = fit(preferred, bounds(content));
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.width = width + "px";
    panel.style.height = height + "px";
  }

  function pointer(handle, edge) {
    let drag;
    handle.addEventListener("pointerdown", event => {
      if (!local() || event.button !== 0 || event.target.closest("button, a")) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, box: fit(preferred, bounds(content)) };
      handle.setPointerCapture(event.pointerId);
      if (edge) event.preventDefault();
    }, { signal });
    handle.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id || !local()) return;
      const area = bounds(content);
      preferred = change(fit(drag.box, area), area, edge, event.clientX - drag.x, event.clientY - drag.y);
      place();
    }, { signal });
    handle.addEventListener("lostpointercapture", () => { drag = undefined; }, { signal });
  }

  pointer(heading, "");
  for (const edge of edges) {
    const handle = document.createElement("span");
    handle.className = "video-dock-resize";
    handle.dataset.edge = edge;
    handle.setAttribute("aria-hidden", "true");
    panel.append(handle);
    pointer(handle, edge);
  }

  const arrows = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
  caption.addEventListener("keydown", event => {
    const delta = Object.hasOwn(arrows, event.key) && arrows[event.key];
    if (!delta || !local()) return;
    event.preventDefault();
    const area = bounds(content);
    preferred = change(fit(preferred, area), area, event.shiftKey ? "se" : "", ...delta);
    place();
  }, { signal });

  const observer = new ResizeObserver(place);
  observer.observe(content);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  window.addEventListener("resize", place, { signal });
  window.visualViewport?.addEventListener("resize", place, { signal });
  window.visualViewport?.addEventListener("scroll", place, { signal });
  return { place };
}

async function openPopup(width, height, desktop) {
  const url = new URL("/video-window.html", location.origin).href;
  const ticket = desktop && await desktop.authorize();
  if (desktop && !ticket) throw new Error("Video window unavailable");
  const popup = window.open(url, "zelotez-rooms-video",
    "popup,width=" + width + ",height=" + height + ",resizable=yes" + (ticket ? ",roomsVideoTicket=" + ticket : ""));
  if (!popup) throw new Error("Video window blocked");
  try {
    for (const deadline = Date.now() + 5000; Date.now() < deadline && !popup.closed;) {
      if (popup.location.href === url && popup.document.body) return popup;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch {
    // The popup navigated away from the Rooms origin.
  }
  popup.close();
  throw new Error("Video window unavailable");
}

export async function openVideoWindow({ width, height }) {
  const desktop = window.roomsDesktopVideo;
  width = Math.max(minimum.width, Math.round(width));
  height = Math.max(minimum.height, Math.round(height));
  const popup = !desktop && window.documentPictureInPicture?.requestWindow
    ? await window.documentPictureInPicture.requestWindow({ width, height })
    : await openPopup(width, height, desktop);
  let timeout;
  try {
    const target = popup.document;
    target.documentElement.lang = document.documentElement.lang;
    target.body.classList.add("video-window");
    const loaded = Promise.all(sheets.map(name => new Promise((resolve, reject) => {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./" + name, import.meta.url).href;
      link.onload = resolve;
      link.onerror = reject;
      target.head.append(link);
    })));
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Video window styles unavailable")), 5000);
    });
    await Promise.race([loaded, deadline]);
    if (popup.closed) throw new Error("Video window closed");
    return popup;
  } catch (error) {
    popup.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
