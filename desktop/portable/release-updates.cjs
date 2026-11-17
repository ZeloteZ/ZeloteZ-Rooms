"use strict";

const versionPattern = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/u;
const artifactPattern = /^[a-z0-9]{1,12}(?:-[a-z0-9]{1,12}){1,2}$/u;
const maxResponse = 2048;
const checkIntervals = ["1", "6", "24", "168"];

function releasePage(origin, version) {
  return releaseEndpoint(origin) && typeof version === "string" && versionPattern.test(version)
    ? origin + "/#/downloads" : null;
}

function newerVersion(candidate, installed) {
  if (typeof candidate !== "string" || typeof installed !== "string" ||
      !versionPattern.test(candidate) || !versionPattern.test(installed)) return false;
  const current = installed.split(".").map(Number);
  const difference = candidate.split(".").map((part, index) => Number(part) - current[index]).find(part => part !== 0);
  return difference > 0;
}

function artifactFor(platform, arch) {
  if (platform === "linux") return "linux-" + arch;
  if (platform === "win32") return "windows-" + arch;
  if (platform === "darwin") return "macos-" + arch;
  return "";
}

function releaseEndpoint(origin) {
  if (typeof origin !== "string" || !origin) return null;
  try {
    const url = new URL(origin);
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== origin || url.port === "0" || (url.protocol !== "https:" && !loopback)) return null;
    return url.origin + "/api/desktop/release";
  } catch {
    return null;
  }
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

async function findUpdate({ origin, installed, platform, arch, signal, fetchRelease = fetch }) {
  const endpoint = releaseEndpoint(origin);
  if (!endpoint) return { status: "instance" };
  const deadline = AbortSignal.timeout(8000);
  try {
    const response = await fetchRelease(endpoint, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Accept: "application/json" },
    });
    const release = await readMetadata(response);
    if (!release || Object.keys(release).length !== 4 || release.product !== "zelotez-rooms" || release.protocol !== 1 ||
        !releasePage(origin, release.version) || !Array.isArray(release.artifacts) || release.artifacts.length > 16 ||
        new Set(release.artifacts).size !== release.artifacts.length ||
        release.artifacts.some(artifact => typeof artifact !== "string" || !artifactPattern.test(artifact))) {
      return { status: "unavailable" };
    }
    if (!newerVersion(release.version, installed)) return { status: "current" };
    return { status: "available", version: release.version, installer: release.artifacts.includes(artifactFor(platform, arch)) };
  } catch {
    return { status: signal?.aborted ? "cancelled" : "unavailable" };
  }
}

module.exports = { checkIntervals, findUpdate, releasePage };
