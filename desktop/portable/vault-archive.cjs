"use strict";

const { randomUUID } = require("node:crypto");
const { constants: { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY } } = require("node:fs");
const { lstat, open, readdir } = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { fileURLToPath } = require("node:url");
const { ZipFile } = require("yazl");
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 ** 4;
const MAX_SELECTION = 256;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 32;
const fail = (code = "VAULT_SELECTION_CHANGED") => Object.assign(
  new Error("The selected files cannot be archived safely or changed during the transfer."), { code });
function failure(error) {
  if (error?.name === "AbortError" || /^VAULT_(?:SELECTION_CHANGED|UNREADABLE|INVALID_NAME|SYMLINK|LIMIT|ARCHIVE_FAILED)$/u.test(error?.code ?? "")) return error;
  const code = error?.code === "EACCES" || error?.code === "EPERM" ? "VAULT_UNREADABLE"
    : error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "VAULT_SELECTION_CHANGED"
      : error?.code === "ELOOP" ? "VAULT_SYMLINK" : error?.code === "ENAMETOOLONG" ? "VAULT_INVALID_NAME" : "VAULT_ARCHIVE_FAILED";
  // Native paths and filesystem error details stay outside renderer-facing errors.
  return fail(code);
}
const abortError = () => Object.assign(new Error("The archive transfer was cancelled."), { name: "AbortError" });
const same = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);

function parseVaultArguments(args, cwd = process.cwd(), platform = process.platform) {
  if (!Array.isArray(args)) return null;
  const index = args.indexOf("--vault-share");
  if (index < 0 || args.lastIndexOf("--vault-share") !== index || args[index + 1] !== "--") return null;
  const input = args.slice(index + 2), paths = platform === "win32" ? path.win32 : path;
  if (typeof cwd !== "string" || cwd.length > 32768 || /[\p{Cc}]/u.test(cwd) || !paths.isAbsolute(cwd) || !input.length || input.length > MAX_SELECTION || input.some(value =>
    typeof value !== "string" || !value || value.length > 32768 || /[\p{Cc}]/u.test(value))) return null;
  const selected = [];
  for (const value of input) {
    let file = value;
    if (/^file:/iu.test(value)) {
      // File managers can supply GFile URIs instead of native paths. Never
      // reinterpret a URI as a relative filename or accept a remote authority.
      if (!/^file:\/\/(?:localhost)?\//iu.test(value) || /[?#]/u.test(value) || /%(?:2f|5c)/iu.test(value)) return null;
      try {
        const url = new URL(value);
        if (url.protocol !== "file:" || url.hostname || url.username || url.password || url.port || url.search || url.hash || url.pathname.startsWith("//")) return null;
        file = fileURLToPath(url, { windows: platform === "win32" });
      } catch { return null; }
      if (!paths.isAbsolute(file) || /[\p{Cc}]/u.test(file)) return null;
    } else if (!paths.isAbsolute(value) && /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
      return null;
    }
    selected.push(paths.resolve(cwd, file));
  }
  const unique = [...new Set(selected)];
  return unique.length ? unique : null;
}
function safeName(value) {
  if (!value || value === "." || value === ".." || /[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) ||
      /[. ]$/u.test(value) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(value) || Buffer.byteLength(value) > 255) throw fail("VAULT_INVALID_NAME");
  return value;
}
function selectionName(value) {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." ||
      /[\/\\\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) || Buffer.byteLength(value) > 255) throw fail("VAULT_INVALID_NAME");
  return value;
}
function fileType(name) {
  const extension = path.extname(name).slice(1).toLowerCase();
  const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska",
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus", m4a: "audio/mp4", aac: "audio/aac", weba: "audio/webm", mka: "audio/x-matroska",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
    json: "application/json", xml: "application/xml", svg: "image/svg+xml", html: "text/html", htm: "text/html", css: "text/css", vtt: "text/vtt",
    zip: "application/zip", tar: "application/x-tar", tgz: "application/gzip", gz: "application/gzip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  return Object.hasOwn(types, extension) ? types[extension] : "application/octet-stream";
}
async function planSelection(selected, { signal, maxBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRIES, maxDepth = MAX_DEPTH } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_SELECTION ||
      selected.some(value => typeof value !== "string" || !path.isAbsolute(value)) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARCHIVE_BYTES ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_ENTRIES ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DEPTH) throw fail("VAULT_ARCHIVE_FAILED");
  const names = [], items = [];
  let totalBytes = 0, entryCount = 0, metadataBytes = 0;
  try {
    for (const selectedFile of selected) {
      signal?.throwIfAborted();
      const file = path.resolve(selectedFile), name = selectionName(path.basename(file));
      const info = await lstat(file, { bigint: true }); signal?.throwIfAborted();
      if (info.isSymbolicLink()) throw fail("VAULT_SYMLINK");
      let item;
      if (info.isFile()) {
        if (info.size > BigInt(maxBytes - totalBytes)) throw fail("VAULT_LIMIT");
        const size = Number(info.size);
        item = { kind: "file", name, type: fileType(name), size, entry: { file, name, info, ancestors: [] } };
        totalBytes += size; entryCount += 1; metadataBytes += Buffer.byteLength(name);
      } else if (info.isDirectory()) {
        const archiveName = selectionName(name + ".zip");
        const plan = await planArchive([file], { signal, maxBytes: maxBytes - totalBytes, maxEntries: maxEntries - entryCount, maxDepth });
        if (!plan.entries[0].info.isDirectory() || !same(info, plan.entries[0].info)) throw fail();
        item = { kind: "directory", name: archiveName, type: "application/zip", plan };
        totalBytes += plan.totalBytes; entryCount += plan.entries.length;
        metadataBytes += plan.entries.reduce((total, entry) => total + Buffer.byteLength(entry.name), 0);
      } else throw fail("VAULT_ARCHIVE_FAILED");
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes || entryCount > maxEntries || metadataBytes > 1024 * 1024) throw fail("VAULT_LIMIT");
      names.push(name); items.push(item);
    }
    return { names, items, totalBytes };
  } catch (error) { throw failure(error); }
}
async function planArchive(selected, { signal, maxBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRIES, maxDepth = MAX_DEPTH } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_SELECTION ||
      selected.some(value => typeof value !== "string" || !path.isAbsolute(value))) throw fail("VAULT_ARCHIVE_FAILED");
  const entries = [], names = [], seen = new Set();
  let totalBytes = 0, metadataBytes = 0;
  const check = () => { signal?.throwIfAborted(); };
  async function walk(file, name, depth, ancestors) {
    check();
    if (depth > maxDepth || entries.length >= maxEntries) throw fail("VAULT_LIMIT");
    const parts = name.split("/"); parts.forEach(safeName);
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw fail("VAULT_INVALID_NAME");
    seen.add(folded);
    metadataBytes += Buffer.byteLength(name);
    if (metadataBytes > 1024 * 1024) throw fail("VAULT_LIMIT");
    const info = await lstat(file, { bigint: true }); check();
    if (info.isSymbolicLink()) throw fail("VAULT_SYMLINK");
    if (!info.isFile() && !info.isDirectory()) throw fail("VAULT_ARCHIVE_FAILED");
    const entry = { file, name, info, ancestors };
    entries.push(entry);
    if (info.isFile()) {
      if (info.size > BigInt(maxBytes)) throw fail("VAULT_LIMIT");
      totalBytes += Number(info.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw fail("VAULT_LIMIT");
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
  } catch (error) { throw failure(error); }
}
async function createVaultArchive(plan, { signal } = {}) {
  if (!plan || !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > MAX_ENTRIES) throw fail("VAULT_ARCHIVE_FAILED");
  signal?.throwIfAborted();
  const zip = new ZipFile(), sources = new Set(), handles = new Set();
  let closed = false, error = null, position = 0, reading = false, pending = null;
  const controller = new AbortController();
  const check = () => {
    if (closed) throw error || abortError();
    if (signal?.aborted || controller.signal.aborted) throw abortError();
  };
  function stop(reason) {
    if (closed) return;
    closed = true;
    error ||= reason ? failure(reason) : abortError();
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
    } catch (caught) { throw failure(caught); }
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
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) throw fail("VAULT_LIMIT");
    const iterator = zip.outputStream[Symbol.asyncIterator]();
    const archive = {
      id: randomUUID(), name: `ZeloteZ-Vault-${new Date().toISOString().slice(0, 10)}.zip`, type: "application/zip", size,
      async read(offset, length) {
        check();
        if (reading || offset !== position || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
            length < 1 || length > MAX_READ_BYTES || offset + length > size) throw fail("VAULT_ARCHIVE_FAILED");
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
    throw failure(caught);
  }
}
function selectionArchiveSize(plan, signal) {
  const zip = new ZipFile();
  let size, error;
  zip.on("error", caught => { error ||= failure(caught); });
  zip.outputStream.on("error", () => {});
  try {
    for (const entry of plan.entries) {
      signal?.throwIfAborted();
      if (entry.info.isDirectory()) zip.addEmptyDirectory(entry.name, { mtime: new Date(Number(entry.info.mtimeMs)), mode: 0o40755 });
      else zip.addReadStreamLazy(entry.name, { size: Number(entry.info.size), compress: false,
        mtime: new Date(Number(entry.info.mtimeMs)), mode: 0o100600 }, () => {});
    }
    // Stored entries have a size determined entirely by their metadata. No
    // source callback opens a file, and this short-lived ZIP is discarded.
    zip.end(total => { size = total; });
    if (error) throw error;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) throw fail("VAULT_LIMIT");
    return size;
  } finally { zip.outputStream.destroy(); }
}
function selectionLastModified(info) {
  const value = Number(info.mtimeMs);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : undefined;
}
function createRawSelectionSource(item, { signal } = {}) {
  const entry = item.entry;
  let handle = null, closing = null, position = 0, reading = false, closed = false, finished = false, error = null;
  const check = () => {
    if (closed) throw error || abortError();
    signal?.throwIfAborted();
  };
  async function close() {
    const previous = handle; handle = null;
    if (previous) closing = Promise.allSettled([closing, previous.close()]);
    const pending = closing;
    await pending;
    if (closing === pending) closing = null;
  }
  function stop(reason) {
    closed = true; error ||= failure(reason);
    signal?.removeEventListener("abort", onAbort);
    return close();
  }
  const onAbort = () => { void stop(abortError()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  async function verifyPath() {
    const info = await lstat(entry.file, { bigint: true }); check();
    if (info.isSymbolicLink()) throw fail("VAULT_SYMLINK");
    if (!info.isFile() || !same(entry.info, info)) throw fail();
  }
  return {
    id: randomUUID(), kind: "file", name: item.name, type: item.type, size: item.size,
    lastModified: selectionLastModified(entry.info),
    async read(offset, length) {
      check();
      if (finished || reading || !Number.isSafeInteger(offset) || offset !== position || !Number.isSafeInteger(length) ||
          length < 0 || length > MAX_READ_BYTES || offset + length > item.size || (!length && item.size !== 0)) throw fail("VAULT_ARCHIVE_FAILED");
      reading = true;
      const result = Buffer.alloc(length);
      try {
        if (!handle) {
          await verifyPath();
          handle = await open(entry.file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); check();
        }
        const before = await handle.stat({ bigint: true }); check();
        if (!before.isFile() || !same(entry.info, before)) throw fail();
        let written = 0;
        while (written < length) {
          const chunk = await handle.read(result, written, length - written, position + written); check();
          if (!chunk.bytesRead) throw fail();
          written += chunk.bytesRead;
        }
        const after = await handle.stat({ bigint: true }); check();
        if (!after.isFile() || !same(entry.info, after)) throw fail();
        await verifyPath();
        if (position + length === item.size) {
          await close(); check(); finished = true;
          signal?.removeEventListener("abort", onAbort);
        }
        position += length;
        return result;
      } catch (caught) {
        result.fill(0); await stop(caught); throw error;
      } finally { reading = false; }
    },
    async cancel() { await stop(abortError()); return true; },
  };
}
function createDirectorySelectionSource(item, { signal } = {}) {
  const size = selectionArchiveSize(item.plan, signal);
  let archive = null, opening = null, reading = false, closed = false, position = 0, error = null;
  const check = () => {
    if (closed) throw error || abortError();
    signal?.throwIfAborted();
  };
  async function stop(reason) {
    closed = true; error ||= failure(reason);
    signal?.removeEventListener("abort", onAbort);
    await opening?.catch(() => {});
    await archive?.cancel().catch(() => {});
  }
  const onAbort = () => { void stop(abortError()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  async function verifyDirectories() {
    for (const entry of item.plan.entries) {
      if (!entry.info.isDirectory()) continue;
      const after = await lstat(entry.file, { bigint: true }); check();
      if (after.isSymbolicLink()) throw fail("VAULT_SYMLINK");
      if (!after.isDirectory() || !same(entry.info, after)) throw fail();
    }
  }
  return {
    id: randomUUID(), kind: "directory", name: item.name, type: "application/zip", size,
    lastModified: selectionLastModified(item.plan.entries[0].info),
    async read(offset, length) {
      check();
      if (reading || !Number.isSafeInteger(offset) || offset !== position || !Number.isSafeInteger(length) ||
          length < 1 || length > MAX_READ_BYTES || offset + length > size) throw fail("VAULT_ARCHIVE_FAILED");
      reading = true;
      let result;
      try {
        opening ||= (async () => {
          await verifyDirectories();
          const source = await createVaultArchive(item.plan, { signal });
          if (closed || signal?.aborted) { await source.cancel(); check(); }
          if (source.size !== size) { await source.cancel(); throw fail(); }
          archive = source;
          return source;
        })();
        const source = await opening; check();
        result = await source.read(offset, length); check();
        if (position + length === size) await verifyDirectories();
        position += length;
        if (position === size) signal?.removeEventListener("abort", onAbort);
        return result;
      } catch (caught) {
        result?.fill(0); await stop(caught); throw error;
      } finally { reading = false; }
    },
    async cancel() { await stop(abortError()); return true; },
  };
}
async function createVaultSelection(plan, { signal } = {}) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length || plan.items.length > MAX_SELECTION) throw fail("VAULT_ARCHIVE_FAILED");
  const sources = [];
  let totalBytes = 0;
  try {
    for (const item of plan.items) {
      signal?.throwIfAborted();
      selectionName(item.name);
      if (item.kind === "file" && (!item.entry?.info?.isFile() || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_ARCHIVE_BYTES)) throw fail("VAULT_ARCHIVE_FAILED");
      const source = item.kind === "file" ? createRawSelectionSource(item, { signal })
        : item.kind === "directory" && item.plan?.entries?.[0]?.info?.isDirectory() ? createDirectorySelectionSource(item, { signal }) : null;
      if (!source) throw fail("VAULT_ARCHIVE_FAILED");
      sources.push(source); totalBytes += source.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) throw fail("VAULT_LIMIT");
    }
    return sources;
  } catch (caught) {
    await Promise.allSettled(sources.map(source => source.cancel()));
    throw failure(caught);
  }
}
module.exports = { parseVaultArguments, planArchive, createVaultArchive, planSelection, createVaultSelection,
  MAX_READ_BYTES, MAX_ARCHIVE_BYTES, MAX_SELECTION };
