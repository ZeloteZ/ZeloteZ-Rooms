// Executed as a fixed script in the verified Rooms tab. It receives only the origin and video ID.
export async function createSignedInRoom(origin, videoId) {
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  const inRooms = () => window === window.top && location.origin === origin && location.pathname === "/";
  if (!inRooms() || !/^[A-Za-z0-9_-]{11}$/u.test(videoId)) return null;

  let accountId;
  let createdRoom;
  async function request(path, method, data) {
    if (!inRooms()) throw new Error("The Rooms tab changed");
    const headers = {};
    if (data) headers["Content-Type"] = "application/json";
    if (accountId) headers["X-Rooms-Account"] = accountId;
    const response = await fetch(new URL(path, origin), { method, headers, body: data ? JSON.stringify(data) : undefined,
      credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("The Rooms request failed");
    return response.status === 204 ? null : response.json();
  }

  try {
    const session = await request("/api/auth/session", "GET");
    if (!id.test(session?.user?.id ?? "")) return null;
    accountId = session.user.id;
    const room = await request("/api/quick-rooms", "POST", { source: "youtube", guestAccess: false, memberVisibility: false });
    if (!id.test(room?.topicId ?? "") || !id.test(room.channelId) || room.publicId !== room.topicId ||
      room.source !== "youtube" || room.guestAccess !== false || room.memberVisibility !== false) return null;
    createdRoom = room.publicId;
    const watch = await request("/api/channels/" + room.channelId + "/watch", "POST", { source: "youtube", videoId });
    if (watch?.party?.videoId !== videoId || watch.party.source !== "youtube") throw new Error("The watch party could not start");
    return { topicId: room.topicId, channelId: room.channelId };
  } catch {
    if (createdRoom && inRooms()) await request("/api/quick-rooms/" + createdRoom, "DELETE").catch(() => {});
    return null;
  }
}
