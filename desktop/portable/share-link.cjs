"use strict";

const scheme = "zelotez-rooms";
const youtube = /^zelotez-rooms:\/\/share\/youtube\/([A-Za-z0-9_-]{11})\?instance=([A-Za-z0-9._~%-]+)$/u;

function parseShareLink(value, serverOrigin) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const match = youtube.exec(value);
  if (!match) return null;
  try {
    const address = decodeURIComponent(match[2]);
    const origin = serverOrigin(address);
    if (!origin || origin !== address) return null;
    return { origin, fragment: "#/share/youtube/" + match[1] };
  } catch {
    return null;
  }
}

function shareLinkFromArguments(args, serverOrigin) {
  const links = args.filter(arg => typeof arg === "string" && arg.startsWith(scheme + "://"));
  return links.length === 1 ? parseShareLink(links[0], serverOrigin) : null;
}

module.exports = { scheme, parseShareLink, shareLinkFromArguments };
