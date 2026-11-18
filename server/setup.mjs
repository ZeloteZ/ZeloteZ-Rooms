import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, closeSync, fsyncSync, openSync, readFileSync, writeFileSync, fstatSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertOrigin, json, readJson, RequestError, transaction } from './http.mjs'

const unavailable = 'Die Ersteinrichtung ist nicht verfügbar. Nutze für eine bestehende Instanz die lokale Betreiber-Wiederherstellung.'
const invalidKey = 'Der Einrichtungsschlüssel ist ungültig.'
const now = () => Math.floor(Date.now() / 1000)
const digest = value => createHash('sha256').update(value).digest()

export function initializeSetupState(db, { legacy = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS first_run_setup (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'sealed')),
      sealed_at INTEGER
    ) STRICT;
  `)
  db.prepare(`INSERT OR IGNORE INTO first_run_setup (id, state, sealed_at)
      SELECT 1, CASE WHEN ? OR EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM invites)
        THEN 'sealed' ELSE 'pending' END,
        CASE WHEN ? OR EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM invites)
        THEN unixepoch() ELSE NULL END`).run(legacy ? 1 : 0, legacy ? 1 : 0)
  db.exec(`
    UPDATE first_run_setup SET state = 'sealed', sealed_at = COALESCE(sealed_at, unixepoch())
      WHERE state != 'sealed' AND (EXISTS (SELECT 1 FROM users)
        OR (state = 'pending' AND EXISTS (SELECT 1 FROM invites)));
  `)
}

export function sealSetup(db) {
  db.prepare("UPDATE first_run_setup SET state = 'sealed', sealed_at = COALESCE(sealed_at, ?) WHERE id = 1 AND state != 'sealed'").run(now())
}

export function setupPending(db) {
  if (!['pending', 'active'].includes(db.prepare('SELECT state FROM first_run_setup WHERE id = 1').get()?.state)) return false
  // Preserve the seal even if an account is later removed through local maintenance.
  if (db.prepare('SELECT 1 FROM users').get()) {
    sealSetup(db)
    return false
  }
  return true
}

export function activateSetup(db) {
  if (!setupPending(db)) throw new RequestError(409, unavailable)
  db.prepare("UPDATE first_run_setup SET state = 'active' WHERE id = 1").run()
}

function validateKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new Error('Der Einrichtungsschlüssel muss aus 32 zufälligen Bytes im Base64url-Format bestehen.')
  }
  return value
}

function readKeyFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128) {
      throw new Error('Die Datei für den Einrichtungsschlüssel muss eine private reguläre Datei sein (0600).')
    }
    const text = readFileSync(fd, 'utf8')
    return validateKey(text.endsWith('\n') ? text.slice(0, -1) : text)
  } finally {
    closeSync(fd)
  }
}

export function configuredSetupKey(db, env = process.env) {
  if (!setupPending(db)) return null
  if (env.ROOMS_SETUP_TOKEN !== undefined) return validateKey(env.ROOMS_SETUP_TOKEN)
  return env.ROOMS_SETUP_TOKEN_FILE ? readKeyFile(env.ROOMS_SETUP_TOKEN_FILE) : null
}

export function ensureSetupKey(db, env = process.env) {
  if (!setupPending(db)) return null
  return transaction(db, () => {
    if (!setupPending(db)) return null
    if (env.ROOMS_SETUP_TOKEN !== undefined) return validateKey(env.ROOMS_SETUP_TOKEN)
    const path = env.ROOMS_SETUP_TOKEN_FILE || join(env.APP_DATA_DIR ?? '/data', '.rooms-setup-token')
    try { return readKeyFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp'
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const key = randomBytes(32).toString('base64url')
      writeFileSync(fd, key + '\n')
      fsyncSync(fd)
      try { linkSync(temporary, path) } catch (error) {
        if (error.code === 'EEXIST') return readKeyFile(path)
        throw error
      }
      return key
    } finally {
      closeSync(fd)
      unlinkSync(temporary)
    }
  })
}

export function createSetup(db, { publicOrigin, bootstrap, setupKey = null, ipFor = req => req.socket?.remoteAddress ?? 'unknown' }) {
  const expected = setupKey === null ? null : digest(validateKey(setupKey))
  const attempts = new Map()
  const available = () => Boolean(expected && setupPending(db))
  function limited(req, res) {
    const time = now()
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key)
    const ip = ipFor(req)
    let entry = attempts.get(ip)
    if (!entry) {
      if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value)
      entry = { count: 0, until: time + 60 }
      attempts.set(ip, entry)
    }
    if (++entry.count <= 12) return false
    json(res, 429, { error: 'Zu viele Versuche. Warte bitte einen Moment.' }, { 'Retry-After': String(entry.until - time) })
    return true
  }
  async function handle(req, res, pathname) {
    if (pathname !== '/api/setup') return false
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (req.url !== '/api/setup') throw new RequestError(400, 'Ungültige Auswahl.')
    if (req.method === 'GET') {
      json(res, 200, { available: available() })
      return true
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Diese Anfrage ist hier nicht erlaubt.' }, { Allow: 'GET, POST' })
      return true
    }
    assertOrigin(req, publicOrigin)
    if (!available()) throw new RequestError(409, unavailable)
    if (limited(req, res)) return true
    const body = await readJson(req, 256)
    if (Object.keys(body).length !== 1 || typeof body.key !== 'string' || body.key.length !== 43 ||
        !timingSafeEqual(digest(body.key), expected)) throw new RequestError(403, invalidKey)
    // bootstrap rechecks durable state and rotates the one pending owner invite in one transaction.
    const invite = bootstrap()
    json(res, 201, { invite: new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite') })
    return true
  }
  return { handle }
}
