"use strict";

const { randomUUID } = require("node:crypto");
const { constants: { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY } } = require("node:fs");
const { lstat, open, readdir } = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { ZipFile } = require("yazl");
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 ** 4;
const MAX_SELECTION = 256;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 32;
const fail = () => new Error("The selected files cannot be archived safely or changed during the transfer.");
const abortError = () => Object.assign(new Error("The archive transfer was cancelled."), { name: "AbortError" });
const same = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);

function parseVaultArguments(args, cwd = process.cwd(), platform = process.platform) {
  if (!Array.isArray(args)) return null;
  const index = args.indexOf("--vault-share");
  if (index < 0 || args.lastIndexOf("--vault-share") !== index || args[index + 1] !== "--") return null;
  const input = args.slice(index + 2), paths = platform === "win32" ? path.win32 : path;
  if (typeof cwd !== "string" || cwd.length > 32768 || /[\p{Cc}]/u.test(cwd) || !paths.isAbsolute(cwd) || !input.length || input.length > MAX_SELECTION || input.some(value =>
    typeof value !== "string" || !value || value.length > 32768 || /[\p{Cc}]/u.test(value))) return null;
  const selected = [...new Set(input.map(value => paths.resolve(cwd, value)))];
  return selected.length ? selected : null;
}
function safeName(value) {
  if (!value || value === "." || value === ".." || /[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) ||
      /[. ]$/u.test(value) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(value) || Buffer.byteLength(value) > 255) throw fail();
  return value;
}
async function planArchive(selected, { signal, maxBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRIES, maxDepth = MAX_DEPTH } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_SELECTION ||
      selected.some(value => typeof value !== "string" || !path.isAbsolute(value))) throw fail();
  const entries = [], names = [], seen = new Set();
  let totalBytes = 0, metadataBytes = 0;
  const check = () => { signal?.throwIfAborted(); };
  async function walk(file, name, depth, ancestors) {
    check();
    if (depth > maxDepth || entries.length >= maxEntries) throw fail();
    const parts = name.split("/"); parts.forEach(safeName);
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw fail();
    seen.add(folded);
    metadataBytes += Buffer.byteLength(name);
    if (metadataBytes > 1024 * 1024) throw fail();
    const info = await lstat(file, { bigint: true }); check();
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw fail();
    const entry = { file, name, info, ancestors };
    entries.push(entry);
    if (info.isFile()) {
      if (info.size > BigInt(maxBytes)) throw fail();
      totalBytes += Number(info.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw fail();
    } else {
      const children = await readdir(file); check();
      children.sort();
      for (const child of children) await walk(path.join(file, child), name + "/" + safeName(child), depth + 1, [...ancestors, entry]);
      const after = await lstat(file, { bigint: true }); check();
      if (!same(info, after) || !after.isDirectory()) throw fail();
    }
  }
  try {
    for (const selectedFile of selected) {
      const file = path.resolve(selectedFile), name = safeName(path.basename(file));
      names.push(name);
      await walk(file, name, 0, []);
    }
    return { entries, names, totalBytes };
  } catch (error) { if (error.name === "AbortError") throw error; throw fail(); }
}
async function createVaultArchive(plan, { signal } = {}) {
  if (!plan || !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > MAX_ENTRIES) throw fail();
  signal?.throwIfAborted();
  const zip = new ZipFile(), sources = new Set(), handles = new Set();
  let closed = false, error = null, position = 0, reading = false, pending = null;
  const controller = new AbortController();
  const check = () => { if (closed || signal?.aborted || controller.signal.aborted) throw abortError(); };
  function stop(reason) {
    if (closed) return;
    closed = true;
    error ||= reason || abortError();
    controller.abort();
    for (const source of sources) source.destroy(error);
    zip.outputStream.destroy(error);
    for (const handle of handles) void handle.close().catch(() => {});
  }
  zip.on("error", stop);
  zip.outputStream.on("error", () => {});
  const onAbort = () => stop(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  async function verifyAncestors(entry) {
    for (const ancestor of entry.ancestors) {
      const after = await lstat(ancestor.file, { bigint: true }); check();
      if (!after.isDirectory() || !same(ancestor.info, after)) throw fail();
    }
  }
  async function* readFile(entry) {
    let handle;
    try {
      check(); await verifyAncestors(entry);
      handle = await open(entry.file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); handles.add(handle); check();
      const before = await handle.stat({ bigint: true }); check();
      if (!before.isFile() || !same(entry.info, before)) throw fail();
      let offset = 0;
      while (offset < Number(entry.info.size)) {
        check();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(entry.info.size) - offset));
        const result = await handle.read(buffer, 0, buffer.length, offset); check();
        if (!result.bytesRead) { buffer.fill(0); throw fail(); }
        offset += result.bytesRead;
        yield buffer.subarray(0, result.bytesRead);
      }
      const after = await handle.stat({ bigint: true }); check();
      if (!same(before, after)) throw fail();
      await verifyAncestors(entry);
    } catch (caught) { throw caught.name === "AbortError" ? caught : fail(); }
    finally { if (handle) { handles.delete(handle); await handle.close().catch(() => {}); } }
  }
  try {
    for (const entry of plan.entries) {
      if (entry.info.isDirectory()) zip.addEmptyDirectory(entry.name, { mtime: new Date(Number(entry.info.mtimeMs)), mode: 0o40755 });
      else zip.addReadStreamLazy(entry.name, { size: Number(entry.info.size), compress: false,
        mtime: new Date(Number(entry.info.mtimeMs)), mode: 0o100600 }, callback => {
        const source = Readable.from(readFile(entry), { objectMode: false, highWaterMark: 64 * 1024 });
        sources.add(source);
        source.once("close", () => sources.delete(source)); source.on("error", stop);
        callback(null, source);
      });
    }
    const size = await new Promise((resolve, reject) => {
      zip.once("error", reject);
      zip.end(total => { zip.off("error", reject); resolve(total); });
    });
    check();
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) throw fail();
    const iterator = zip.outputStream[Symbol.asyncIterator]();
    const archive = {
      id: randomUUID(), name: `ZeloteZ-Vault-${new Date().toISOString().slice(0, 10)}.zip`, type: "application/zip", size,
      async read(offset, length) {
        check();
        if (reading || offset !== position || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
            length < 1 || length > MAX_READ_BYTES || offset + length > size) throw fail();
        reading = true;
        const result = Buffer.alloc(length); let written = 0;
        try {
          while (written < length) {
            check();
            if (!pending?.length) {
              const next = await iterator.next(); check();
              if (next.done) throw fail();
              pending = Buffer.from(next.value);
            }
            const count = Math.min(pending.length, length - written);
            pending.copy(result, written, 0, count); written += count;
            const previous = pending;
            pending = count === pending.length ? null : pending.subarray(count);
            previous.subarray(0, count).fill(0);
          }
          if (position + length === size) {
            if (pending?.length) throw fail();
            const tail = await iterator.next(); check();
            if (!tail.done) throw fail();
            signal?.removeEventListener("abort", onAbort);
          }
          check(); position += length;
          return result;
        } catch (caught) { result.fill(0); stop(caught); throw error || fail(); }
        finally { reading = false; }
      },
      async cancel() {
        signal?.removeEventListener("abort", onAbort);
        pending?.fill(0); pending = null;
        stop(abortError());
        await Promise.allSettled([...handles].map(handle => handle.close()));
        return true;
      },
    };
    return archive;
  } catch (caught) {
    signal?.removeEventListener("abort", onAbort); stop(caught);
    throw caught.name === "AbortError" ? caught : fail();
  }
}
module.exports = { parseVaultArguments, planArchive, createVaultArchive, MAX_READ_BYTES, MAX_ARCHIVE_BYTES, MAX_SELECTION };
