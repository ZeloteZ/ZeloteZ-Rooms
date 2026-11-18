import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, lstatSync, mkdirSync } from 'node:fs'
import { open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { validateEnvelope } from './community.mjs'
import { json, readBytes, readJson, RequestError, transaction } from './http.mjs'

export const vaultLimits = Object.freeze({ chunkBytes: 4 * 1024 ** 2, defaultQuotaBytes: 2 * 1024 ** 3,
  minQuotaBytes: 1024 ** 2, maxQuotaBytes: 1024 ** 4, maxEntries: 5000, idBytes: 128,
  uploadLifetime: 24 * 60 * 60 * 1000, maxShareLifetime: 365 * 24 * 60 * 60 * 1000 })
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const missing = () => new RequestError(404, 'Dieser Vault-Eintrag ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Vault-Anfrage.')
const full = () => new RequestError(413, 'Dein Vault-Speicherlimit ist erreicht.')
const busy = () => new RequestError(429, 'Warte, bis andere Vault-Übertragungen abgeschlossen sind.')
const digest = bytes => createHash('sha256').update(bytes).digest()
const jsonBytes = value => Buffer.byteLength(value)
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) throw invalid(); return value }
function encoded(value, length) {
  return typeof value === 'string' && value.length === length && /^[A-Za-z0-9_-]+$/u.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
}
function keys(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw invalid()
}
function descriptor(value, entryId) {
  keys(value, ['v', 'id', 'contentId', 'size', 'chunkSize', 'chunks', 'cipherSize'],
    ['v', 'id', 'contentId', 'size', 'chunkSize', 'chunks', 'cipherSize'])
  const { size, chunks, cipherSize } = value
  if (value.v !== 1 || value.id !== entryId || !encoded(value.contentId, 43) ||
      !Number.isSafeInteger(size) || size < 0 || size > vaultLimits.maxQuotaBytes ||
      value.chunkSize !== vaultLimits.chunkBytes || chunks !== Math.max(1, Math.ceil(size / vaultLimits.chunkBytes)) ||
      cipherSize !== size + chunks * 28) throw invalid()
  return { v: 1, id: entryId, contentId: value.contentId, size, chunkSize: vaultLimits.chunkBytes, chunks, cipherSize }
}
function ownerEnvelope(value, ownerId, recipientId) {
  const recipients = [{ id: ownerId }, ...(recipientId ? [{ id: recipientId }] : [])]
  const result = validateEnvelope(value, recipients)
  if (jsonBytes(result) > 12288) throw invalid()
  return result
}
function publicEnvelope(value) {
  keys(value, ['v', 'nonce', 'body'], ['v', 'nonce', 'body'])
  if (value.v !== 1 || !encoded(value.nonce, 16) || typeof value.body !== 'string' ||
      value.body.length < 22 || value.body.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(value.body) ||
      Buffer.from(value.body, 'base64url').toString('base64url') !== value.body) throw invalid()
  return JSON.stringify({ v: 1, nonce: value.nonce, body: value.body })
}
function storageError(error) {
  if ((['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(error.code) || (Number.isInteger(error.errcode) && (error.errcode & 255) === 13))) {
    return new RequestError(507, 'Der Vault-Speicher des Servers ist voll. Bitte versuche es später erneut.')
  }
  return error
}

export function createVault(db, { dataDir, requireSession, requireAdmin, clock = Date.now }) {
  const root = join(dataDir, 'vault')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Invalid vault storage directory')
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_config (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      quota_bytes INTEGER NOT NULL CHECK(quota_bytes BETWEEN ${vaultLimits.minQuotaBytes} AND ${vaultLimits.maxQuotaBytes})
    ) STRICT;
    INSERT OR IGNORE INTO vault_config VALUES (1,0,${vaultLimits.defaultQuotaBytes});
    CREATE TABLE IF NOT EXISTS vault_entries (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES vault_entries(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file','folder')), envelope TEXT NOT NULL CHECK(json_valid(envelope)),
      descriptor TEXT CHECK(descriptor IS NULL OR json_valid(descriptor)),
      allocated_bytes INTEGER NOT NULL CHECK(allocated_bytes >= 0),
      state TEXT NOT NULL CHECK(state IN ('uploading','ready')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK((kind = 'folder' AND descriptor IS NULL AND state = 'ready') OR (kind = 'file' AND descriptor IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id,parent_id);
    CREATE INDEX IF NOT EXISTS vault_entries_staging ON vault_entries(state,updated_at);
    CREATE TABLE IF NOT EXISTS vault_chunks (
      entry_id TEXT NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0), size INTEGER NOT NULL CHECK(size >= 28),
      digest BLOB NOT NULL CHECK(length(digest) = 32), PRIMARY KEY(entry_id,chunk_index)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS vault_shares (
      id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT REFERENCES users(id) ON DELETE CASCADE, token_hash BLOB,
      envelope TEXT NOT NULL CHECK(json_valid(envelope)), owner_envelope TEXT CHECK(owner_envelope IS NULL OR json_valid(owner_envelope)),
      allocated_bytes INTEGER NOT NULL CHECK(allocated_bytes > 0), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      CHECK((recipient_id IS NULL AND token_hash IS NOT NULL AND length(token_hash) = 32) OR (recipient_id IS NOT NULL AND token_hash IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_shares_recipient ON vault_shares(recipient_id,expires_at);
    CREATE INDEX IF NOT EXISTS vault_shares_entry ON vault_shares(entry_id);
    CREATE INDEX IF NOT EXISTS vault_shares_owner ON vault_shares(owner_id);
    CREATE INDEX IF NOT EXISTS vault_shares_expiry ON vault_shares(expires_at);
    CREATE TABLE IF NOT EXISTS vault_used_ids (
      digest BLOB PRIMARY KEY CHECK(length(digest) = 32)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS vault_migrations (version INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS vault_identity_usage (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bytes INTEGER NOT NULL CHECK(bytes >= 0)
    ) STRICT;
  `)
  // Hashed tombstones prevent a deleted/revoked capability from being revived
  // under another account. A separate quota counter avoids retaining ownership
  // links for the individual deleted IDs while bounding their durable storage.
  if (!db.prepare('SELECT 1 FROM vault_migrations WHERE version=1').get()) transaction(db, () => {
    const existingIds = db.prepare('SELECT id FROM vault_entries UNION ALL SELECT id FROM vault_shares')
    for (const row of existingIds.iterate()) db.prepare('INSERT OR IGNORE INTO vault_used_ids VALUES (?)').run(digest(row.id))
    db.prepare(`INSERT OR IGNORE INTO vault_identity_usage(user_id,bytes)
      SELECT owner_id,count(*) * ${vaultLimits.idBytes} FROM
        (SELECT owner_id FROM vault_entries UNION ALL SELECT owner_id FROM vault_shares) GROUP BY owner_id`).run()
    db.prepare('INSERT INTO vault_migrations VALUES (1)').run()
  })
  const settings = db.prepare('SELECT enabled,quota_bytes FROM vault_config WHERE singleton = 1')
  const entryFor = db.prepare('SELECT * FROM vault_entries WHERE id = ? AND owner_id = ?')
  const activeOwner = db.prepare('SELECT u.* FROM users u WHERE u.id = ? AND NOT EXISTS(SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id)')
  const chunkFor = db.prepare('SELECT size,digest FROM vault_chunks WHERE entry_id = ? AND chunk_index = ?')
  const uploads = new Map()
  const housekeepingEntries = new Set()
  const reads = new Map()
  const largeReads = new Set()
  let readCount = 0
  let cleanupRunning = null
  const mutationBudgets = new Map()
  let globalMutationBudget = { expires: 0, remaining: 0 }
  function mutationBudget(ownerId) {
    const now = clock()
    if (globalMutationBudget.expires <= now) globalMutationBudget = { expires: now + 60000, remaining: 2000 }
    let budget = mutationBudgets.get(ownerId)
    if (!budget || budget.expires <= now) {
      budget = { expires: now + 60000, remaining: 600 }
      mutationBudgets.set(ownerId, budget)
    }
    if (!budget.remaining || !globalMutationBudget.remaining) throw new RequestError(429, 'Zu viele Vault-Anfragen. Versuche es in einer Minute erneut.')
    budget.remaining--; globalMutationBudget.remaining--
  }
  function reserveId(entryId, ownerId, additionalBytes) {
    const hash = digest(entryId)
    if (db.prepare('SELECT 1 FROM vault_used_ids WHERE digest = ?').get(hash)) throw new RequestError(409, 'Dieser Vault-Eintrag wurde bereits verwendet.')
    assertSpace(ownerId, additionalBytes + vaultLimits.idBytes)
    db.prepare('INSERT INTO vault_used_ids VALUES (?)').run(hash)
    db.prepare(`INSERT INTO vault_identity_usage(user_id,bytes) VALUES (?,?) ON CONFLICT(user_id)
      DO UPDATE SET bytes = bytes + excluded.bytes`).run(ownerId, vaultLimits.idBytes)
  }
  let closed = false
  function config() {
    const row = settings.get()
    return { enabled: row.enabled === 1, quotaBytes: row.quota_bytes, chunkBytes: vaultLimits.chunkBytes,
      maxEntries: vaultLimits.maxEntries, maxQuotaBytes: vaultLimits.maxQuotaBytes }
  }
  function enabled() { if (!config().enabled) throw missing() }
  function usage(ownerId) {
    const rows = db.prepare(`SELECT coalesce(sum(CASE WHEN state='ready' THEN allocated_bytes ELSE 0 END),0) AS used,
      coalesce(sum(CASE WHEN state='uploading' THEN allocated_bytes ELSE 0 END),0) AS reserved
      FROM vault_entries WHERE owner_id = ?`).get(ownerId)
    const shared = db.prepare('SELECT coalesce(sum(allocated_bytes),0) AS bytes FROM vault_shares WHERE owner_id = ?').get(ownerId).bytes
    const bookkeeping = db.prepare('SELECT bytes FROM vault_identity_usage WHERE user_id = ?').get(ownerId)?.bytes ?? 0
    return { usedBytes: rows.used + shared + bookkeeping, reservedBytes: rows.reserved }
  }
  function assertSpace(ownerId, extraBytes) {
    const { usedBytes, reservedBytes } = usage(ownerId)
    if (extraBytes > 0 && usedBytes + reservedBytes + extraBytes > config().quotaBytes) throw full()
  }
  function current(request, userId) {
    const user = requireSession(request)
    if (user.id !== userId) throw missing()
    enabled()
    return user
  }
  function own(entryId, ownerId) {
    const row = entryFor.get(id(entryId), ownerId)
    if (!row) throw missing()
    return row
  }
  function view(row, chunks = false) {
    return { id: row.id, ownerId: row.owner_id, parentId: row.parent_id, kind: row.kind,
      envelope: JSON.parse(row.envelope), descriptor: row.descriptor ? JSON.parse(row.descriptor) : null,
      state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(chunks && row.state === 'uploading' ? { uploadedChunks: db.prepare('SELECT chunk_index FROM vault_chunks WHERE entry_id = ? ORDER BY chunk_index').all(row.id).map(x => x.chunk_index) } : {}) }
  }
  function parent(parentId, ownerId, movingId) {
    if (parentId === null) return null
    const folder = own(parentId, ownerId)
    if (folder.kind !== 'folder' || folder.state !== 'ready') throw invalid()
    let cursor = folder
    let ancestors = 0
    for (let depth = 0; cursor; depth++) {
      ancestors++
      if (depth >= 31 || cursor.id === movingId) throw invalid()
      cursor = cursor.parent_id ? own(cursor.parent_id, ownerId) : null
    }
    if (movingId) {
      const height = db.prepare(`WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM vault_entries WHERE id = ? AND owner_id = ?
        UNION ALL SELECT e.id,t.depth + 1 FROM vault_entries e JOIN tree t ON e.parent_id = t.id WHERE e.owner_id = ?)
        SELECT coalesce(max(depth),0) AS height FROM tree`).get(movingId, ownerId, ownerId).height
      if (ancestors + 1 + height > 32) throw invalid()
    }
    return parentId
  }
  function shareView(row, { received = false, publicRead = false } = {}) {
    const file = db.prepare("SELECT * FROM vault_entries WHERE id = ? AND state = 'ready' AND kind = 'file'").get(row.entry_id)
    const owner = activeOwner.get(row.owner_id)
    if (!file || !owner) throw missing()
    const recipient = !received && !publicRead && row.recipient_id
      ? db.prepare('SELECT id,username,display_name FROM users WHERE id = ?').get(row.recipient_id) : null
    return { id: row.id, entryId: row.entry_id, ownerId: row.owner_id, recipientId: row.recipient_id,
      envelope: JSON.parse(row.envelope), descriptor: JSON.parse(file.descriptor),
      createdAt: row.created_at, expiresAt: row.expires_at,
      ...(recipient ? { recipient: { id: recipient.id, username: recipient.username, displayName: recipient.display_name } } : {}),
      ...(received ? { owner: { id: owner.id, username: owner.username, displayName: owner.display_name, publicKey: JSON.parse(owner.public_key) } } : {}),
      ...(!received && !publicRead && row.owner_envelope ? { ownerEnvelope: JSON.parse(row.owner_envelope) } : {}) }
  }
  async function removeDirectories(ids) {
    for (const entryId of ids) await rm(join(root, entryId), { recursive: true, force: true })
  }
  function expireShares() { db.prepare('DELETE FROM vault_shares WHERE expires_at <= ?').run(clock()) }
  function pruneStaging() {
    const rows = db.prepare("SELECT id FROM vault_entries WHERE state='uploading' AND updated_at < ?").all(clock() - vaultLimits.uploadLifetime)
    const ids = rows.filter(row => ![...uploads.keys()].some(key => key.startsWith(row.id + ':'))).map(row => row.id)
    if (ids.length) transaction(db, () => { for (const entryId of ids) db.prepare('DELETE FROM vault_entries WHERE id = ?').run(entryId) })
    expireShares()
    for (const [ownerId, budget] of mutationBudgets) if (budget.expires <= clock()) mutationBudgets.delete(ownerId)
    return ids
  }
  async function cleanStorage() {
    await removeDirectories(pruneStaging())
    for (const item of await readdir(root, { withFileTypes: true })) {
      if ([...uploads.keys()].some(key => key.startsWith(item.name + ':'))) continue
      housekeepingEntries.add(item.name)
      try {
        const path = join(root, item.name)
        const exists = db.prepare("SELECT 1 FROM vault_entries WHERE id = ? AND kind='file'").get(item.name)
        if (!exists || !item.isDirectory() || item.isSymbolicLink()) {
          await rm(path, { recursive: true, force: true }); continue
        }
        for (const chunk of await readdir(path, { withFileTypes: true })) {
          const validName = /^(?:0|[1-9]\d{0,5})$/u.test(chunk.name)
          if (validName && chunkFor.get(item.name, Number(chunk.name)) && chunk.isFile() && !chunk.isSymbolicLink()) continue
          await rm(join(path, chunk.name), { recursive: true, force: true })
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      } finally { housekeepingEntries.delete(item.name) }
    }
  }
  function cleanup() {
    if (!cleanupRunning) cleanupRunning = cleanStorage().finally(() => { cleanupRunning = null })
    return cleanupRunning
  }
  const ready = cleanup()
  ready.catch(() => {})
  // Housekeeping touches only the dedicated generated-ID storage namespace.
  const timer = setInterval(() => { if (!closed) cleanup().catch(() => {}) }, 10 * 60 * 1000)
  timer.unref()

  async function putChunk(request, response, user, entryId, chunkText) {
    const file = own(entryId, user.id)
    if (file.kind !== 'file' || file.state !== 'uploading' || !/^(?:0|[1-9]\d{0,5})$/u.test(chunkText)) throw invalid()
    const index = Number(chunkText)
    const info = JSON.parse(file.descriptor)
    if (index >= info.chunks) throw invalid()
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new RequestError(415, 'Nur verschlüsselte Dateien sind erlaubt.')
    const key = `${entryId}:${index}`
    if (housekeepingEntries.has(entryId) || uploads.has(key) || uploads.size >= 8 || [...uploads.values()].filter(ownerId => ownerId === user.id).length >= 2) throw busy()
    uploads.set(key, user.id)
    const temporary = join(root, entryId, '.' + randomUUID())
    const destination = join(root, entryId, String(index))
    let published = false
    let committed = false
    try {
      const expected = Math.min(vaultLimits.chunkBytes, Math.max(0, info.size - index * vaultLimits.chunkBytes)) + 28
      const bytes = await readBytes(request, expected)
      if (bytes.length !== expected) throw invalid()
      current(request, user.id)
      if (own(entryId, user.id).state !== 'uploading') throw invalid()
      const hash = digest(bytes)
      const previous = chunkFor.get(entryId, index)
      if (previous) {
        if (previous.size !== expected || !timingSafeEqual(Buffer.from(previous.digest), hash)) throw new RequestError(409, 'Dieser Vault-Dateiteil wurde bereits verwendet.')
        const stored = await stat(destination)
        current(request, user.id)
        if (stored.size !== expected || own(entryId, user.id).state !== 'uploading') throw missing()
        return response.writeHead(204).end()
      }
      const fileHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await fileHandle.writeFile(bytes); await fileHandle.sync() } finally { await fileHandle.close() }
      current(request, user.id)
      if (own(entryId, user.id).state !== 'uploading') throw missing()
      await rename(temporary, destination)
      published = true
      const directory = await open(join(root, entryId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      current(request, user.id)
      transaction(db, () => {
        if (own(entryId, user.id).state !== 'uploading') throw missing()
        db.prepare('INSERT INTO vault_chunks VALUES (?,?,?,?)').run(entryId, index, bytes.length, hash)
        db.prepare('UPDATE vault_entries SET updated_at = ? WHERE id = ?').run(clock(), entryId)
      })
      committed = true
      response.writeHead(204).end()
    } catch (error) {
      throw storageError(error)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      if (published && !committed) await rm(destination, { force: true }).catch(() => {})
      uploads.delete(key)
    }
  }
  async function sendChunk(request, response, rowFor, indexText, readerKey) {
    if (!/^(?:0|[1-9]\d{0,5})$/u.test(indexText)) throw missing()
    const index = Number(indexText)
    let file = rowFor()
    const info = JSON.parse(file.descriptor)
    if (file.kind !== 'file' || file.state !== 'ready' || index >= info.chunks) throw missing()
    if (readCount >= 16 || (reads.get(readerKey) ?? 0) >= 2) throw busy()
    readCount++; reads.set(readerKey, (reads.get(readerKey) ?? 0) + 1)
    let fileHandle
    try {
      const stored = chunkFor.get(file.id, index)
      if (!stored) throw missing()
      fileHandle = await open(join(root, file.id, String(index)), constants.O_RDONLY | constants.O_NOFOLLOW)
      const actual = await fileHandle.stat()
      if (!actual.isFile() || actual.size !== stored.size || actual.size > vaultLimits.chunkBytes + 28) throw missing()
      const bytes = await fileHandle.readFile()
      file = rowFor() // Reject revocation, disablement, logout and deletion while reading.
      if (!file || !timingSafeEqual(digest(bytes), Buffer.from(stored.digest))) throw missing()
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
        'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
      response.end(bytes)
      await finished(response, { cleanup: true })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') throw missing()
      throw error
    } finally {
      await fileHandle?.close()
      readCount--
      const count = reads.get(readerKey) - 1
      if (count) reads.set(readerKey, count)
      else reads.delete(readerKey)
    }
  }
  async function largeResponse(ownerId, response, value) {
    if (largeReads.has(ownerId) || largeReads.size >= 2) throw busy()
    largeReads.add(ownerId)
    try {
      json(response, 200, value())
      await finished(response, { cleanup: true })
    } finally { largeReads.delete(ownerId) }
  }
  function sharedFile(shareId, { token, recipientId } = {}) {
    enabled()
    const share = db.prepare('SELECT * FROM vault_shares WHERE id = ? AND expires_at > ?').get(id(shareId), clock())
    if (!share || !activeOwner.get(share.owner_id)) throw missing()
    if (recipientId) {
      if (share.recipient_id !== recipientId && share.owner_id !== recipientId) throw missing()
    } else {
      if (share.recipient_id !== null || !encoded(token, 43) || !timingSafeEqual(digest(token), Buffer.from(share.token_hash))) throw missing()
    }
    const file = entryFor.get(share.entry_id, share.owner_id)
    if (!file || file.kind !== 'file' || file.state !== 'ready') throw missing()
    return { share, file }
  }
  async function handlePublic(request, response, url) {
    const { pathname: path } = typeof url === 'string' ? new URL(url, 'http://vault') : url
    if (!path.startsWith('/api/vault/public/')) return false
    await ready
    if (path === '/api/vault/public/open' && request.method === 'POST') {
      enabled()
      const body = await readJson(request, 1024)
      keys(body, ['id', 'token'], ['id', 'token'])
      const { share } = sharedFile(body.id, { token: body.token })
      json(response, 200, { share: shareView(share, { publicRead: true }) })
      return true
    }
    const match = /^\/api\/vault\/public\/([a-f0-9-]{36})\/chunks\/(\d+)$/.exec(path)
    if (match && request.method === 'GET') {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.authorization ?? '')?.[1]
      await sendChunk(request, response, () => sharedFile(match[1], { token }).file, match[2], 'public:' + match[1])
      return true
    }
    throw missing()
  }
  async function handle(request, response, url) {
    const target = typeof url === 'string' ? new URL(url, 'http://vault') : url
    const { pathname: path, searchParams } = target
    if (path !== '/api/vault' && !path.startsWith('/api/vault/')) return false
    let user = requireSession(request)
    await ready
    user = requireSession(request)
    const method = request.method
    if (path === '/api/vault/config') {
      if (method === 'GET') { json(response, 200, config()); return true }
      if (method !== 'PATCH') throw missing()
      requireAdmin(request, { approved: true })
      const body = await readJson(request, 1024)
      keys(body, ['enabled', 'quotaBytes'], ['enabled', 'quotaBytes'])
      if (typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.quotaBytes) ||
          body.quotaBytes < vaultLimits.minQuotaBytes || body.quotaBytes > vaultLimits.maxQuotaBytes) throw invalid()
      requireAdmin(request, { approved: true })
      let discarded = []
      transaction(db, () => {
        db.prepare('UPDATE vault_config SET enabled = ?,quota_bytes = ? WHERE singleton = 1').run(body.enabled ? 1 : 0, body.quotaBytes)
        if (!body.enabled) {
          discarded = db.prepare("SELECT id FROM vault_entries WHERE state='uploading'").all().map(row => row.id)
          db.prepare("DELETE FROM vault_entries WHERE state='uploading'").run()
        }
      })
      await removeDirectories(discarded)
      json(response, 200, config()); return true
    }
    enabled()
    if (['POST', 'PATCH'].includes(method)) mutationBudget(user.id)
    expireShares()
    if (path === '/api/vault' && method === 'GET') {
      await largeResponse(user.id, response, () => {
        const entries = db.prepare('SELECT * FROM vault_entries WHERE owner_id = ? ORDER BY created_at,id').all(user.id)
        const received = db.prepare(`SELECT s.* FROM vault_shares s JOIN vault_entries e ON e.id = s.entry_id
          WHERE s.recipient_id = ? AND s.expires_at > ? AND e.state='ready'
          AND NOT EXISTS(SELECT 1 FROM disabled_accounts d WHERE d.user_id = s.owner_id)
          ORDER BY s.created_at DESC LIMIT 1000`).all(user.id, clock())
        return { ...config(), ...usage(user.id), entries: entries.map(row => view(row, true)),
          receivedShares: received.map(row => shareView(row, { received: true })) }
      })
      return true
    }
    if (path === '/api/vault/recipients' && method === 'GET') {
      const query = searchParams.get('query') ?? ''
      if (query.length > 80) throw invalid()
      const escaped = query.replace(/[\\%_]/gu, value => '\\' + value)
      const recipients = db.prepare(`SELECT id,username,display_name,public_key FROM users u WHERE id <> ?
        AND NOT EXISTS(SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id)
        AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY username LIMIT 40`)
        .all(user.id, '%' + escaped + '%', '%' + escaped + '%')
        .map(row => ({ id: row.id, username: row.username, displayName: row.display_name, publicKey: JSON.parse(row.public_key) }))
      json(response, 200, { recipients }); return true
    }
    if (path === '/api/vault/entries' && method === 'POST') {
      const body = await readJson(request, 16384)
      current(request, user.id)
      keys(body, ['id', 'parentId', 'kind', 'envelope', 'descriptor'], ['id', 'parentId', 'kind', 'envelope', 'descriptor'])
      const entryId = id(body.id)
      if (!['file', 'folder'].includes(body.kind)) throw invalid()
      const envelope = ownerEnvelope(body.envelope, user.id)
      const desc = body.kind === 'file' ? descriptor(body.descriptor, entryId) : null
      if (body.kind === 'folder' && body.descriptor !== null) throw invalid()
      const descJson = desc ? JSON.stringify(desc) : null
      const allocated = (desc?.cipherSize ?? 0) + jsonBytes(envelope) + (descJson ? jsonBytes(descJson) : 0)
      const now = clock()
      transaction(db, () => {
        parent(body.parentId, user.id)
        if (housekeepingEntries.has(entryId)) throw busy()
        if (db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(entryId)) throw new RequestError(409, 'Dieser Vault-Eintrag wurde bereits verwendet.')
        if (db.prepare('SELECT count(*) AS n FROM vault_entries WHERE owner_id = ?').get(user.id).n >= vaultLimits.maxEntries) throw full()
        if (desc && (db.prepare("SELECT count(*) AS n FROM vault_entries WHERE state='uploading'").get().n >= 32 ||
            db.prepare("SELECT count(*) AS n FROM vault_entries WHERE owner_id = ? AND state='uploading'").get(user.id).n >= 4)) throw busy()
        reserveId(entryId, user.id, allocated)
        db.prepare('INSERT INTO vault_entries VALUES (?,?,?,?,?,?,?,?,?,?)').run(entryId, user.id, body.parentId,
          body.kind, envelope, descJson, allocated, desc ? 'uploading' : 'ready', now, now)
      })
      if (desc) {
        try { mkdirSync(join(root, entryId), { mode: 0o700 }) } catch (error) {
          db.prepare('DELETE FROM vault_entries WHERE id = ?').run(entryId)
          throw storageError(error)
        }
      }
      json(response, 201, { entry: view(own(entryId, user.id), true) }); return true
    }
    const chunks = /^\/api\/vault\/entries\/([a-f0-9-]{36})\/chunks\/(\d+)$/.exec(path)
    if (chunks) {
      if (method === 'PUT') { await putChunk(request, response, user, chunks[1], chunks[2]); return true }
      if (method === 'GET') {
        await sendChunk(request, response, () => { current(request, user.id); return own(chunks[1], user.id) }, chunks[2], 'user:' + user.id)
        return true
      }
      throw missing()
    }
    const received = /^\/api\/vault\/received\/([a-f0-9-]{36})\/chunks\/(\d+)$/.exec(path)
    if (received && method === 'GET') {
      await sendChunk(request, response, () => { current(request, user.id); return sharedFile(received[1], { recipientId: user.id }).file }, received[2], 'user:' + user.id)
      return true
    }
    const completed = /^\/api\/vault\/entries\/([a-f0-9-]{36})\/complete$/.exec(path)
    if (completed && method === 'POST') {
      const body = await readJson(request, 1024)
      keys(body, [])
      current(request, user.id)
      const row = transaction(db, () => {
        const file = own(completed[1], user.id)
        if (file.kind !== 'file') throw invalid()
        if (file.state === 'ready') return file
        const desc = JSON.parse(file.descriptor)
        const chunks = db.prepare('SELECT count(*) AS n,coalesce(sum(size),0) AS bytes FROM vault_chunks WHERE entry_id = ?').get(file.id)
        if (chunks.n !== desc.chunks || chunks.bytes !== desc.cipherSize) throw new RequestError(409, 'Die Vault-Datei ist noch nicht vollständig hochgeladen.')
        db.prepare("UPDATE vault_entries SET state='ready',updated_at = ? WHERE id = ?").run(clock(), file.id)
        return own(file.id, user.id)
      })
      json(response, 200, { entry: view(row) }); return true
    }
    const sharePath = /^\/api\/vault\/entries\/([a-f0-9-]{36})\/shares$/.exec(path)
    if (sharePath) {
      const file = own(sharePath[1], user.id)
      if (file.kind !== 'file' || file.state !== 'ready') throw invalid()
      if (method === 'GET') {
        const rows = db.prepare('SELECT * FROM vault_shares WHERE entry_id = ? ORDER BY created_at DESC').all(file.id)
        json(response, 200, { shares: rows.map(row => shareView(row)) }); return true
      }
      if (method !== 'POST') throw missing()
      const body = await readJson(request, 32768)
      current(request, user.id)
      keys(body, ['id', 'recipientId', 'tokenHash', 'envelope', 'ownerEnvelope', 'expiresAt'], ['id', 'envelope', 'expiresAt'])
      const shareId = id(body.id)
      if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt < clock() + 1000 || body.expiresAt > clock() + vaultLimits.maxShareLifetime) throw invalid()
      let recipientId = null
      let tokenHash = null
      let envelope
      let ownerHeader = null
      if (body.recipientId !== undefined) {
        recipientId = id(body.recipientId)
        if (recipientId === user.id || !activeOwner.get(recipientId) || Object.hasOwn(body, 'tokenHash') || Object.hasOwn(body, 'ownerEnvelope')) throw invalid()
        envelope = ownerEnvelope(body.envelope, user.id, recipientId)
      } else {
        if (!encoded(body.tokenHash, 43)) throw invalid()
        tokenHash = Buffer.from(body.tokenHash, 'base64url')
        envelope = publicEnvelope(body.envelope)
        if (body.ownerEnvelope !== undefined) ownerHeader = ownerEnvelope(body.ownerEnvelope, user.id)
      }
      const allocated = jsonBytes(envelope) + (ownerHeader ? jsonBytes(ownerHeader) : 0)
      const row = transaction(db, () => {
        const currentFile = own(file.id, user.id)
        if (currentFile.state !== 'ready') throw missing()
        if (db.prepare('SELECT 1 FROM vault_shares WHERE id = ?').get(shareId)) throw new RequestError(409, 'Diese Vault-Freigabe wurde bereits verwendet.')
        if (db.prepare('SELECT count(*) AS n FROM vault_shares WHERE entry_id = ?').get(file.id).n >= 32 ||
            db.prepare('SELECT count(*) AS n FROM vault_shares WHERE owner_id = ?').get(user.id).n >= 1000) throw full()
        reserveId(shareId, user.id, allocated)
        db.prepare('INSERT INTO vault_shares VALUES (?,?,?,?,?,?,?,?,?,?)').run(shareId, file.id, user.id, recipientId,
          tokenHash, envelope, ownerHeader, allocated, clock(), body.expiresAt)
        return db.prepare('SELECT * FROM vault_shares WHERE id = ?').get(shareId)
      })
      json(response, 201, { share: shareView(row) }); return true
    }
    const revoked = /^\/api\/vault\/shares\/([a-f0-9-]{36})$/.exec(path)
    if (revoked && method === 'DELETE') {
      const result = db.prepare('DELETE FROM vault_shares WHERE id = ? AND owner_id = ?').run(id(revoked[1]), user.id)
      if (!result.changes) throw missing()
      response.writeHead(204).end(); return true
    }
    const entryPath = /^\/api\/vault\/entries\/([a-f0-9-]{36})$/.exec(path)
    if (entryPath) {
      const row = own(entryPath[1], user.id)
      if (method === 'GET') { json(response, 200, { entry: view(row, true) }); return true }
      if (method === 'DELETE') {
        const removed = transaction(db, () => {
          const ids = db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM vault_entries WHERE id = ? AND owner_id = ?
            UNION ALL SELECT e.id FROM vault_entries e JOIN children c ON e.parent_id = c.id WHERE e.owner_id = ?)
            SELECT e.id FROM vault_entries e JOIN children c ON e.id = c.id WHERE e.kind='file'`).all(row.id, user.id, user.id).map(x => x.id)
          db.prepare('DELETE FROM vault_entries WHERE id = ? AND owner_id = ?').run(row.id, user.id)
          return ids
        })
        await removeDirectories(removed)
        response.writeHead(204).end(); return true
      }
      if (method === 'PATCH') {
        const body = await readJson(request, 16384)
        current(request, user.id)
        keys(body, ['parentId', 'envelope'])
        if (!Object.keys(body).length) throw invalid()
        const updated = transaction(db, () => {
          const old = own(row.id, user.id)
          const nextParent = Object.hasOwn(body, 'parentId') ? parent(body.parentId, user.id, old.id) : old.parent_id
          const envelope = Object.hasOwn(body, 'envelope') ? ownerEnvelope(body.envelope, user.id) : old.envelope
          const extra = jsonBytes(envelope) - jsonBytes(old.envelope)
          assertSpace(user.id, extra)
          db.prepare('UPDATE vault_entries SET parent_id = ?,envelope = ?,allocated_bytes = allocated_bytes + ?,updated_at = ? WHERE id = ?')
            .run(nextParent, envelope, extra, clock(), old.id)
          return own(old.id, user.id)
        })
        json(response, 200, { entry: view(updated, true) }); return true
      }
    }
    throw missing()
  }
  return { config, usage, ready,
    handle: async (...args) => { try { return await handle(...args) } catch (error) { throw storageError(error) } },
    handlePublic: async (...args) => { try { return await handlePublic(...args) } catch (error) { throw storageError(error) } },
    cleanup, close() { closed = true; clearInterval(timer); return cleanupRunning ?? Promise.resolve() } }
}
