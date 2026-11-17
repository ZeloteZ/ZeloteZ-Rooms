// The handoff tab may have a valid cookie while its workspace is still locked.
// Only use it to identify the account in this browser context.
export async function readRoomsAccount(origin) {
  const inRooms = () => window === window.top && location.href === origin + "/";
  if (!inRooms()) return null;
  try {
    const response = await fetch(new URL("/api/auth/session", origin), {
      credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const { user } = await response.json();
    const id = user?.id;
    return inRooms() && typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Executed as a fixed script only in an already-open Rooms tab.
export async function createSignedInRoom(origin, videoId, accountId, address, { guestAccess, memberVisibility }) {
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  const inRooms = () => window === window.top && location.origin === origin && location.pathname === "/" && !location.search;
  const ready = () => inRooms() && location.href === address &&
    document.querySelector("#workspace:not([hidden])") && document.querySelector("#auth[hidden]") &&
    document.querySelector("#profile-name")?.getAttribute("data-person-name") === accountId &&
    !document.querySelector("dialog[open]") && (!guestAccess || document.querySelector("#quick-room-dock[data-guest-links]"));
  if (!id.test(accountId) || !/^[A-Za-z0-9_-]{11}$/u.test(videoId) || !ready()) return null;

  let attempted = false;
  let createdRoom;
  async function request(path, method, data, cleanup = false) {
    if (!(cleanup ? inRooms() : ready())) throw new Error("The Rooms tab changed");
    const headers = { "X-Rooms-Account": accountId };
    if (data) headers["Content-Type"] = "application/json";
    const response = await fetch(new URL(path, origin), { method, headers, body: data ? JSON.stringify(data) : undefined,
      credentials: "same-origin", redirect: "error", cache: "no-store", referrer: origin + "/", referrerPolicy: "same-origin",
      signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("The Rooms request failed");
    return response.status === 204 ? null : response.json();
  }

  try {
    const session = await request("/api/auth/session", "GET");
    if (session?.user?.id !== accountId || !ready()) return null;
    attempted = true;
    const room = await request("/api/quick-rooms", "POST", { source: "youtube", guestAccess, memberVisibility });
    if (!id.test(room?.topicId ?? "") || room.publicId !== room.topicId) throw new Error("Invalid Rooms response");
    createdRoom = room.publicId;
    if (typeof room.channelId !== "string" || !id.test(room.channelId) || room.source !== "youtube" ||
        room.guestAccess !== guestAccess || room.memberVisibility !== memberVisibility ||
        (guestAccess && !/^[A-Za-z0-9_-]{43}$/u.test(room.secret ?? ""))) throw new Error("Invalid Rooms response");
    const watch = await request("/api/channels/" + room.channelId + "/watch", "POST", { source: "youtube", videoId });
    if (watch?.party?.videoId !== videoId || watch.party.source !== "youtube") throw new Error("The watch party could not start");
    if (!ready()) throw new Error("The Rooms tab changed");
    // Give the one-time secret directly to the same Rooms tab's in-memory link store.
    if (guestAccess && document.dispatchEvent(new CustomEvent("rooms:guest-link-created", {
      detail: JSON.stringify({ accountId, publicId: room.publicId, secret: room.secret }),
      cancelable: true,
    }))) throw new Error("The Rooms tab could not retain the guest link");
    location.hash = "/rooms/" + room.topicId + "/" + room.channelId;
    return { topicId: room.topicId, channelId: room.channelId };
  } catch {
    if (createdRoom && inRooms()) await request("/api/quick-rooms/" + createdRoom, "DELETE", undefined, true).catch(() => {});
    return attempted ? { handled: false } : null;
  }
}
