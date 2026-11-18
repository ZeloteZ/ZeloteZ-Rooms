"use strict";

const { randomUUID } = require("node:crypto");
const { constants: { O_CREAT, O_EXCL, O_NOFOLLOW = 0, O_WRONLY }, lstatSync, renameSync } = require("node:fs");
const { lstat, open, unlink } = require("node:fs/promises");
const path = require("node:path");
const MAX_DOWNLOAD_BYTES = 1024 ** 4;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const failure = () => new Error("The Vault download could not be saved safely.");
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => identity(a, b) && ["size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
function validateDownload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "name,size" ||
      typeof input.name !== "string" || !input.name.trim() || input.name === "." || input.name === ".." ||
      /[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(input.name) || /[. ]$/u.test(input.name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(input.name) || Buffer.byteLength(input.name) > 255 ||
      !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_DOWNLOAD_BYTES) throw failure();
  return { name: input.name, size: input.size };
}
async function fileInfo(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw failure(); }
}
function safeFile(info) { return info === null || (info.isFile() && !info.isSymbolicLink() && info.nlink === 1n); }
async function createVaultSave(destination, size, { valid = () => true } = {}) {
  if (typeof destination !== "string" || destination.length > 32768 || !path.isAbsolute(destination) || /[\p{Cc}]/u.test(destination) ||
      !Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) throw failure();
  const directory = path.dirname(destination);
  const parent = await fileInfo(directory), initial = await fileInfo(destination);
  if (!valid() || !parent?.isDirectory() || parent.isSymbolicLink() || !safeFile(initial)) throw failure();
  const temporary = path.join(directory, ".zelotez-vault-" + randomUUID() + ".download");
  let handle, temporaryInfo, closed = false, committed = false, writing = false, finalizing = false, position = 0;
  function current() { if (closed || !valid()) throw failure(); }
  async function closeHandle(strict = false) {
    const previous = handle;
    if (!previous) return;
    try { await previous.close(); if (handle === previous) handle = null; }
    catch (error) { if (strict) throw error; if (handle === previous) handle = null; }
  }
  async function removeTemporary() {
    if (!temporaryInfo) return;
    const now = await fileInfo(temporary);
    if (now?.isFile() && identity(now, temporaryInfo)) await unlink(temporary).catch(() => {});
  }
  async function cancel() {
    closed = true;
    await closeHandle();
    if (!committed) await removeTemporary();
    return true;
  }
  try {
    handle = await open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    temporaryInfo = await handle.stat({ bigint: true });
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1n || (process.platform !== "win32" && (temporaryInfo.mode & 0o077n) !== 0n)) throw failure();
    current();
    return {
      id: randomUUID(), size,
      async write(offset, input) {
        let source;
        try {
          current();
          if (writing || finalizing || !Number.isSafeInteger(offset) || offset !== position || !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) throw failure();
          const view = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
          if (!view.byteLength || view.byteLength > MAX_WRITE_BYTES || offset + view.byteLength > size) throw failure();
          source = Buffer.from(view); writing = true;
          let written = 0;
          while (written < source.length) {
            current();
            const result = await handle.write(source, written, source.length - written, offset + written);
            current();
            if (result.bytesWritten < 1) throw failure();
            written += result.bytesWritten;
          }
          position += source.length;
          return true;
        } catch { await cancel(); throw failure(); }
        finally { source?.fill(0); writing = false; }
      },
      async complete() {
        try {
          current();
          if (writing || finalizing || position !== size) throw failure();
          finalizing = true;
          const info = await handle.stat({ bigint: true }); current();
          if (!info.isFile() || !identity(info, temporaryInfo) || info.nlink !== 1n || info.size !== BigInt(size)) throw failure();
          await handle.sync(); current();
          await closeHandle(true); current();
          // Keep the final document-approval check and atomic replacement in one
          // JS turn. Another OS process can still race filesystem syscalls;
          // existing files are never truncated or written in place.
          const nowParent = lstatSync(directory, { bigint: true });
          let nowTarget;
          try { nowTarget = lstatSync(destination, { bigint: true }); }
          catch (error) { if (error.code !== "ENOENT") throw error; nowTarget = null; }
          const nowTemporary = lstatSync(temporary, { bigint: true });
          if (!nowParent.isDirectory() || nowParent.isSymbolicLink() || !identity(parent, nowParent) || !safeFile(nowTarget) ||
              (initial === null ? nowTarget !== null : nowTarget === null || !sameFile(initial, nowTarget)) ||
              !nowTemporary.isFile() || nowTemporary.nlink !== 1n || !identity(temporaryInfo, nowTemporary) || nowTemporary.size !== BigInt(size)) throw failure();
          current();
          renameSync(temporary, destination);
          committed = true; closed = true;
          return true;
        } catch { await cancel(); throw failure(); }
      },
      cancel,
    };
  } catch { await cancel(); throw failure(); }
}
module.exports = { createVaultSave, validateDownload, MAX_DOWNLOAD_BYTES, MAX_WRITE_BYTES };
