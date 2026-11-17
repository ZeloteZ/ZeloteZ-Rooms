"use strict";

const scheme = "zelotez-rooms";
const youtube = /^zelotez-rooms:\/\/share\/youtube\/([A-Za-z0-9_-]{11})\?([^\s?#]+)$/u;
const options = ["guests", "live"];

function parseShareLink(value, serverOrigin) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const match = youtube.exec(value);
  if (!match || match[0] !== value) return null;
  const fields = new Map();
  for (const entry of match[2].split("&")) {
    const [name, raw, extra] = entry.split("=");
    if (typeof raw !== "string" || extra !== undefined || fields.has(name)) return null;
    if (name === "instance") {
      if (!/^[A-Za-z0-9._~%-]+$/u.test(raw)) return null;
    } else if (!options.includes(name) || (raw !== "0" && raw !== "1")) return null;
    fields.set(name, raw);
  }
  if (!fields.has("instance")) return null;
  try {
    const address = decodeURIComponent(fields.get("instance"));
    const origin = serverOrigin(address);
    if (!origin || origin !== address) return null;
    const search = options.filter(name => fields.has(name)).map(name => name + "=" + fields.get(name));
    return { origin, fragment: "#/share/youtube/" + match[1] + (search.length ? "?" + search.join("&") : "") };
  } catch {
    return null;
  }
}

function shareLinkFromArguments(args, serverOrigin) {
  const links = args.filter(arg => typeof arg === "string" && arg.startsWith(scheme + "://"));
  return links.length === 1 ? parseShareLink(links[0], serverOrigin) : null;
}

module.exports = { scheme, parseShareLink, shareLinkFromArguments };
