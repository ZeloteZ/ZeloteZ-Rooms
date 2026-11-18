"use strict";

const versionPattern = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/u;
const repository = "ZeloteZ/ZeloteZ-Rooms";
const releases = `https://github.com/${repository}/releases`;
const latestReleasePage = `${releases}/latest`;
const releaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const maxResponse = 256 * 1024;
const checkIntervals = ["1", "6", "24", "168"];

function releasePage(version) {
  return typeof version === "string" && versionPattern.test(version) ? `${releases}/tag/v${version}` : null;
}

function newerVersion(candidate, installed) {
  if (typeof candidate !== "string" || typeof installed !== "string" ||
      !versionPattern.test(candidate) || !versionPattern.test(installed)) return false;
  const current = installed.split(".").map(Number);
  const difference = candidate.split(".").map((part, index) => Number(part) - current[index]).find(part => part !== 0);
  return difference > 0;
}

function installerName(platform, arch, version) {
  if (arch !== "x64") return null;
  if (platform === "linux") return `ZeloteZ-Rooms-${version}-x86_64.AppImage`;
  if (platform === "win32") return `ZeloteZ-Rooms-${version}-x64.exe`;
  return null;
}

async function readMetadata(response) {
  if (!response.ok || !response.body ||
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" ||
      Number(response.headers.get("content-length")) > maxResponse) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Invalid release metadata");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxResponse) throw new Error("Release metadata is too large");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
}

async function findUpdate({ installed, platform, arch, signal, fetchRelease = fetch }) {
  const deadline = AbortSignal.timeout(8000);
  try {
    const response = await fetchRelease(releaseEndpoint, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Accept: "application/vnd.github+json" },
    });
    const release = await readMetadata(response);
    const tag = release?.tag_name;
    const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : null;
    if (!releasePage(version) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
      return { status: "unavailable" };
    }
    if (!newerVersion(version, installed)) return { status: "current" };
    const name = installerName(platform, arch, version);
    return { status: "available", version,
      installer: name !== null && release.assets.some(asset => asset?.name === name && asset.state === "uploaded") };
  } catch {
    return { status: signal?.aborted ? "cancelled" : "unavailable" };
  }
}

module.exports = { checkIntervals, findUpdate, latestReleasePage, releasePage };
