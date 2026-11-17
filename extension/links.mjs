export const configKey = "roomsInstance";
export const videoIdPattern = /^[A-Za-z0-9_-]{11}$/u;
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function instanceOrigin(address) {
  if (typeof address !== "string" || !/^https?:\/\/[^\s\\/%?#@]+\/?$/iu.test(address.trim())) return null;
  try {
    const url = new URL(address.trim());
    if (url.port === "0" || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function permissionFor(origin) {
  const { protocol, hostname } = new URL(origin);
  return { origins: [protocol + "//" + hostname + "/*"] };
}

export function configFrom(value) {
  const origin = instanceOrigin(value?.origin);
  if (!origin || !["browser", "desktop"].includes(value?.target)) return null;
  return {
    origin, target: value.target,
    guestAccess: value.guestAccess === undefined || value.guestAccess === true,
    memberVisibility: value.memberVisibility === undefined || value.memberVisibility === true,
  };
}

export function youtubeVideoId(address) {
  try {
    const url = new URL(address);
    if (url.origin !== "https://www.youtube.com" || url.username || url.password || url.pathname !== "/watch") return null;
    const ids = url.searchParams.getAll("v");
    return ids.length === 1 && videoIdPattern.test(ids[0]) ? ids[0] : null;
  } catch {
    return null;
  }
}

function endpointArguments(origin, id) {
  if (!origin || instanceOrigin(origin) !== origin || typeof id !== "string" || !videoIdPattern.test(id)) {
    throw new Error("Invalid handoff address");
  }
}

function audienceQuery({ guestAccess, memberVisibility }) {
  return new URLSearchParams({ guests: guestAccess ? "1" : "0", live: memberVisibility ? "1" : "0" });
}

export function browserHandoff(origin, id, audience) {
  endpointArguments(origin, id);
  return new URL("/#/share/youtube/" + id + "?" + audienceQuery(audience), origin).href;
}

export function desktopHandoff(origin, id, audience) {
  endpointArguments(origin, id);
  const url = new URL("zelotez-rooms://share/youtube/" + id);
  url.searchParams.set("instance", origin);
  for (const [key, value] of audienceQuery(audience)) url.searchParams.set(key, value);
  return url.href;
}

function mediaType(response) {
  const type = response.headers.get("content-type");
  return type && !type.includes(",") ? type.split(";", 1)[0].trim().toLowerCase() : "";
}

async function descriptor(response) {
  if (response.status !== 200 || mediaType(response) !== "application/json" || !response.body) {
    await response.body?.cancel();
    throw new Error("invalidInstance");
  }
  const bytes = new Uint8Array(1024);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error("invalidInstance");
      bytes.set(value, offset);
      offset += value.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function verifyInstance(origin) {
  if (!origin || instanceOrigin(origin) !== origin) throw new Error("invalidAddress");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const target = new URL("/api/desktop/instance", origin);
  target.searchParams.set("nonce", nonce);
  const request = { redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(8000) };
  const marker = await descriptor(await fetch(target, request));
  if (!marker || marker.product !== "zelotez-rooms" || marker.origin !== origin || marker.nonce !== nonce) {
    throw new Error("invalidInstance");
  }
  if (marker.protocol !== 1) throw new Error("incompatibleInstance");
  const page = await fetch(origin, { ...request, method: "HEAD" });
  if (page.status !== 200 || mediaType(page) !== "text/html" || page.headers.get("x-zelotez-rooms-client") !== "1") {
    throw new Error("invalidInstance");
  }
}
