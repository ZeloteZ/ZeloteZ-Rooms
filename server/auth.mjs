import { createHash, createPublicKey, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import { assertOrigin, json, readJson, RequestError, transaction } from './http.mjs'

const secondsPerHour = 3600
const sessionLifetime = 7 * 24 * secondsPerHour
const defaultInviteHours = 48
const maxInviteHours = 168
const accountsPerPage = 100
const accountsRestricted = 'Nur der Betreiber kann Konten verwalten.'
const hashVersion = 'scrypt-v1'
const scryptOptions = { N: 2 ** 16, r: 8, p: 2, maxmem: 96 * 1024 ** 2 }
const scryptAsync = promisify(scrypt)
const dummyHash = [hashVersion, randomBytes(16).toString('base64url'), randomToken()].join('$')
const unixTime = () => Math.floor(Date.now() / 1000)
const timestamp = value => value === null ? null : new Date(value * 1000).toISOString()
const digest = value => createHash('sha256').update(value).digest()

function randomToken() {
  return randomBytes(32).toString('base64url')
}

function base64url(value, minLength, maxLength = minLength) {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
}

export function initializeAuthSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      admin INTEGER NOT NULL CHECK (admin IN (0, 1)),
      public_key TEXT NOT NULL CHECK (json_valid(public_key)),
      identity TEXT NOT NULL CHECK (json_valid(identity)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS users_single_site_admin ON users (admin) WHERE admin = 1;

    CREATE TABLE IF NOT EXISTS disabled_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      disabled_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, expires_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      token_hash BLOB NOT NULL UNIQUE,
      grants_admin INTEGER NOT NULL CHECK (grants_admin IN (0, 1)),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      used_at INTEGER,
      revoked_at INTEGER,
      CHECK (used_at IS NULL OR revoked_at IS NULL)
    ) STRICT;
  `)
}

function ownerExists(db) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE admin = 1').get())
}

function inviteInfo(row) {
  return {
    id: row.id,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
    usedAt: timestamp(row.used_at),
    revokedAt: timestamp(row.revoked_at),
    createdBy: row.created_by,
    usedBy: row.used_by,
  }
}

function issueInvite(db, publicOrigin, hours, createdBy, grantsAdmin) {
  const token = randomToken()
  const now = unixTime()
  const id = randomUUID()
  const expires = now + hours * secondsPerHour
  db.prepare(`
    INSERT INTO invites (id, token_hash, grants_admin, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, digest(token), grantsAdmin ? 1 : 0, createdBy, now, expires)

  // Keep the token out of normal access logs and HTTP referrers.
  const url = new URL('/', publicOrigin)
  url.hash = `invite=${token}`
  const row = { id, created_at: now, expires_at: expires, created_by: createdBy, used_at: null, revoked_at: null, used_by: null }
  return { ...inviteInfo(row), url: url.href }
}

export function bootstrapOwnerInvite(db, publicOrigin) {
  initializeAuthSchema(db)
  return transaction(db, () => {
    if (ownerExists(db)) throw new Error('The site already has an owner.')
    db.prepare(`
      UPDATE invites SET revoked_at = ?
      WHERE grants_admin = 1 AND used_at IS NULL AND revoked_at IS NULL
    `).run(unixTime())
    return issueInvite(db, publicOrigin, 24, null, true)
  })
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null
  const username = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ? username : null
}

function displayName(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').trim()
  if (!normalized || [...normalized].length > 48 || /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(normalized)) return null
  return normalized
}

function cleanIdentity(value) {
  if (value?.v !== 1 || !base64url(value.nonce, 16) || !base64url(value.blob, 23, 2048)) return null
  return { v: 1, nonce: value.nonce, blob: value.blob }
}

function cleanPublicKey(value) {
  if (value?.kty !== 'EC' || value.crv !== 'P-256' || Object.hasOwn(value, 'd') ||
      !base64url(value.x, 43) || !base64url(value.y, 43)) return null
  const key = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }
  try {
    createPublicKey({ key, format: 'jwk' })
    return key
  } catch {
    return null
  }
}

function toUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    admin: row.admin === 1,
    publicKey: JSON.parse(row.public_key),
    identity: JSON.parse(row.identity),
  }
}

function accountSummary(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, disabled: row.disabled === 1, admin: row.admin === 1 }
}

function assertExpectedAccount(req, user) {
  const expected = req.headers['x-rooms-account']
  if (expected === undefined || !user || expected === user.id) return
  const error = new RequestError(409, 'Das angemeldete Konto hat sich geändert.')
  error.code = 'ROOMS_ACCOUNT_CHANGED'
  throw error
}

function requestAddress(req, trustProxyIp) {
  const forwarded = req.headers['x-real-ip']
  const address = trustProxyIp && isIP(forwarded) ? forwarded : req.socket.remoteAddress
  if (isIP(address) !== 6) return address ?? 'unknown'
  const canonical = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1)
  const [prefix, suffix] = canonical.split('::')
  const groups = prefix ? prefix.split(':') : []
  if (suffix !== undefined) {
    const tail = suffix ? suffix.split(':') : []
    groups.push(...Array(8 - groups.length - tail.length).fill('0'), ...tail)
  }
  if (groups.slice(0, 6).join(':') === '0:0:0:0:0:ffff') {
    const [high, low] = groups.slice(6).map(group => parseInt(group, 16))
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.')
  }
  return groups.slice(0, 4).join(':')
}

function attemptLimit(maxAttempts, windowSeconds) {
  const attempts = new Map()
  const maxTrackedClients = 4096
  let cleanupAt = 0
  return key => {
    const now = unixTime()
    if (now >= cleanupAt) {
      for (const [id, entry] of attempts) {
        if (entry.expires <= now) attempts.delete(id)
      }
      cleanupAt = now + windowSeconds
    }
    let entry = attempts.get(key)
    if (!entry || entry.expires <= now) {
      if (!entry && attempts.size >= maxTrackedClients) return windowSeconds
      entry = { count: 0, expires: now + windowSeconds }
      attempts.set(key, entry)
    }
    if (entry.count >= maxAttempts) return entry.expires - now
    entry.count++
    return 0
  }
}

export function createAuth(db, { publicOrigin, trustProxyIp = false, profileFor = () => ({}), revokeBroadcasts = () => {} }) {
  initializeAuthSchema(db)
  const present = user => user && { ...user, ...profileFor(user.id) }
  const secure = new URL(publicOrigin).protocol === 'https:'
  const cookieName = secure ? '__Host-zelotez_session' : 'zelotez_session'
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  const selectSession = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.admin, u.public_key, u.identity
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id)
  `)
  const activeSession = db.prepare(`SELECT 1 FROM sessions s WHERE token_hash = ? AND user_id = ? AND expires_at > ?
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = s.user_id)`)
  const selectLogin = db.prepare(`
    SELECT id, username, display_name, password_hash, admin, public_key, identity
    FROM users WHERE username = ?
  `)
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?')
  const deleteAccountSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?')
  const accountDisabled = db.prepare('SELECT 1 FROM disabled_accounts WHERE user_id = ?')
  const disableAccount = db.prepare('INSERT OR IGNORE INTO disabled_accounts (user_id, disabled_at) VALUES (?, ?)')
  const enableAccount = db.prepare('DELETE FROM disabled_accounts WHERE user_id = ?')
  const accountStatus = `SELECT u.id, u.username, u.display_name, u.admin,
    EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id) AS disabled FROM users u`
  const listAccounts = db.prepare(`${accountStatus} WHERE u.username > ? ORDER BY u.username LIMIT ?`)
  const findAccount = db.prepare(`${accountStatus} WHERE u.id = ?`)
  const pruneSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  const limitSessions = db.prepare(`
    DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET 9
    )
  `)
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
  const redeemableInvite = db.prepare(`
    SELECT id, grants_admin FROM invites
    WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `)
  const consumeInvite = db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?')
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, admin, public_key, identity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const usernameExists = db.prepare('SELECT 1 FROM users WHERE username = ?')
  const loginAttempts = attemptLimit(16, 60)
  const loginWork = attemptLimit(80, 60)
  const nameAttempts = attemptLimit(8, 120)
  const inviteAttempts = attemptLimit(10, 60)
  const registrationWork = attemptLimit(24, 60)
  const adminAttempts = attemptLimit(24, 60)
  const hashingClients = new Set()

  function sessionToken(req) {
    const cookies = req.headers.cookie?.split(';') ?? []
    let token = null
    for (const cookie of cookies) {
      const nameAndValue = cookie.trim().split('=')
      if (nameAndValue[0] !== cookieName) continue
      if (token || nameAndValue.length !== 2 || !base64url(nameAndValue[1], 43)) return null
      token = nameAndValue[1]
    }
    return token
  }

  function session(req) {
    const token = sessionToken(req)
    return token ? toUser(selectSession.get(digest(token), unixTime())) : null
  }

  function sessionKey(req) {
    const token = sessionToken(req)
    return token ? digest(token).toString('hex') : null
  }

  function isSessionActive(key, userId) {
    return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) &&
      Boolean(activeSession.get(Buffer.from(key, 'hex'), userId, unixTime()))
  }

  function requireSession(req) {
    const user = session(req)
    if (!user) throw new RequestError(401, 'Bitte melde dich an.')
    assertExpectedAccount(req, user)
    return user
  }

  function requireAdmin(req, message = 'Nur der Betreiber kann Einladungen verwalten.') {
    const user = requireSession(req)
    if (!user.admin) throw new RequestError(403, message)
    return user
  }

  function startSession(req, userId) {
    if (accountDisabled.get(userId)) throw invalidLogin()
    const previousToken = sessionToken(req)
    const token = randomToken()
    const now = unixTime()
    pruneSessions.run(now)
    if (previousToken) deleteSession.run(digest(previousToken))
    limitSessions.run(userId)
    insertSession.run(digest(token), userId, now + sessionLifetime)
    return `${cookieName}=${token}; ${cookieFlags}; Max-Age=${sessionLifetime}`
  }

  async function passwordKey(credential, salt, ip, workBudget, res) {
    if (hashingClients.size >= 2 || hashingClients.has(ip)) {
      throw new RequestError(503, 'Die Anmeldung ist gerade ausgelastet. Versuche es gleich erneut.')
    }
    if (rejectLimited(res, workBudget('global'))) return null
    hashingClients.add(ip)
    try {
      return await scryptAsync(Buffer.from(credential, 'base64url'), salt, 32, scryptOptions)
    } finally {
      hashingClients.delete(ip)
    }
  }

  function rejectLimited(res, retryAfter) {
    if (!retryAfter) return false
    json(res, 429, { error: 'Zu viele Versuche. Warte bitte einen Moment.' }, { 'Retry-After': String(retryAfter) })
    return true
  }

  function invalidLogin() {
    return new RequestError(401, 'Benutzername oder Passwort stimmt nicht.')
  }

  async function login(req, res) {
    const ip = requestAddress(req, trustProxyIp)
    if (rejectLimited(res, loginAttempts(ip))) return
    const body = await readJson(req, 4096)
    const username = normalizeUsername(body?.username)
    if (!username || !base64url(body?.password, 43)) throw invalidLogin()
    if (rejectLimited(res, nameAttempts(`${ip}/${username}`))) return

    const row = selectLogin.get(username)
    const [version, encodedSalt, encodedExpected] = (row?.password_hash ?? dummyHash).split('$')
    if (version !== hashVersion || !base64url(encodedSalt, 22) || !base64url(encodedExpected, 43)) {
      throw new Error('Ungültiger Passwort-Hash in der Datenbank.')
    }
    const salt = Buffer.from(encodedSalt, 'base64url')
    const expected = Buffer.from(encodedExpected, 'base64url')
    const actual = await passwordKey(body.password, salt, ip, loginWork, res)
    if (!actual) return
    if (!timingSafeEqual(actual, expected) || !row) throw invalidLogin()

    const cookie = transaction(db, () => startSession(req, row.id))
    json(res, 200, { user: present(toUser(row)) }, { 'Set-Cookie': cookie })
  }

  async function register(req, res) {
    const ip = requestAddress(req, trustProxyIp)
    if (rejectLimited(res, inviteAttempts(ip))) return
    const body = await readJson(req, 4096)
    const username = normalizeUsername(body?.username)
    const name = displayName(body?.displayName)
    if (!username) throw new RequestError(400, 'Der Benutzername braucht 3 bis 32 Zeichen. Erlaubt sind Buchstaben von A bis Z, Zahlen, Punkt, Bindestrich und Unterstrich.')
    if (!name) throw new RequestError(400, 'Gib einen Anzeigenamen mit bis zu 48 Zeichen ein.')
    if (!base64url(body?.password, 43)) throw new RequestError(400, 'Das Passwort konnte nicht verarbeitet werden.')

    const invalidInvite = () => new RequestError(400, 'Die Einladung ist ungültig, abgelaufen oder schon eingelöst.')
    if (!base64url(body.invite, 43)) throw invalidInvite()
    const inviteHash = digest(body.invite)
    if (!redeemableInvite.get(inviteHash, unixTime())) throw invalidInvite()
    const publicKey = cleanPublicKey(body.publicKey)
    const identity = cleanIdentity(body.identity)
    if (!publicKey || !identity) throw new RequestError(400, 'Der Schlüssel für den verschlüsselten Chat ist ungültig.')

    const salt = randomBytes(16)
    const key = await passwordKey(body.password, salt, ip, registrationWork, res)
    if (!key) return
    const passwordHash = [hashVersion, salt.toString('base64url'), key.toString('base64url')].join('$')
    const result = transaction(db, () => {
      const invite = redeemableInvite.get(inviteHash, unixTime())
      if (!invite || (invite.grants_admin === 1 && ownerExists(db))) throw invalidInvite()
      if (usernameExists.get(username)) throw new RequestError(409, 'Dieser Benutzername ist schon vergeben.')

      const now = unixTime()
      const id = randomUUID()
      const admin = invite.grants_admin === 1
      insertUser.run(id, username, name, passwordHash, admin ? 1 : 0, JSON.stringify(publicKey), JSON.stringify(identity), timestamp(now))
      consumeInvite.run(now, id, invite.id)
      return { user: { id, username, displayName: name, admin, publicKey, identity }, cookie: startSession(req, id) }
    })
    json(res, 201, { user: present(result.user) }, { 'Set-Cookie': result.cookie })
  }

  async function handle(req, res, pathname) {
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const user = session(req)
      assertExpectedAccount(req, user)
      json(res, 200, { user: present(user) })
      return true
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      await login(req, res)
      return true
    }
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      await register(req, res)
      return true
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      const user = session(req)
      assertExpectedAccount(req, user)
      if (!user && req.headers['x-rooms-account'] !== undefined) {
        // A stale tab must not erase a new cookie set by a different sign-in.
        json(res, 200, { ok: true })
        return true
      }
      const token = sessionToken(req)
      if (token) deleteSession.run(digest(token))
      json(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; ${cookieFlags}; Max-Age=0` })
      return true
    }
    if (pathname === '/api/admin/accounts' && req.method === 'GET') {
      requireAdmin(req, accountsRestricted)
      const cursor = new URL(req.url, publicOrigin).searchParams.get('after')
      const after = cursor === null ? '' : normalizeUsername(cursor)
      if (after === null) throw new RequestError(400, 'Ungültige Auswahl.')
      const rows = listAccounts.all(after, accountsPerPage + 1)
      const accounts = rows.slice(0, accountsPerPage).map(accountSummary)
      const next = rows.length > accountsPerPage ? accounts.at(-1).username : null
      json(res, 200, { accounts, next })
      return true
    }
    const accountPath = /^\/api\/admin\/accounts\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.exec(pathname)
    if (accountPath && req.method === 'PATCH') {
      assertOrigin(req, publicOrigin)
      const admin = requireAdmin(req, accountsRestricted)
      if (rejectLimited(res, adminAttempts(admin.id))) return true
      const body = await readJson(req, 1024)
      if (Object.keys(body).length !== 1 || (typeof body.disabled !== 'boolean' && body.revokeSessions !== true)) {
        throw new RequestError(400, 'Ungültige Auswahl.')
      }
      const id = accountPath[1]
      const account = transaction(db, () => {
        requireAdmin(req, accountsRestricted)
        const row = findAccount.get(id)
        if (!row) throw new RequestError(404, 'Nicht gefunden.')
        if (row.admin) throw new RequestError(403, 'Das Betreiberkonto ist geschützt.')
        if (body.disabled === true) disableAccount.run(id, unixTime())
        if (body.disabled === false) enableAccount.run(id)
        if (body.disabled === true || body.revokeSessions === true) {
          deleteAccountSessions.run(id)
          revokeBroadcasts(id)
        }
        return accountSummary(findAccount.get(id))
      })
      json(res, 200, { account })
      return true
    }
    if (pathname === '/api/admin/invites' && req.method === 'GET') {
      requireAdmin(req)
      const rows = db.prepare(`
        SELECT id, created_at, expires_at, created_by, used_at, used_by, revoked_at
        FROM invites WHERE grants_admin = 0 ORDER BY created_at DESC, rowid DESC LIMIT 200
      `).all()
      json(res, 200, { invites: rows.map(inviteInfo) })
      return true
    }
    if (pathname === '/api/admin/invites' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      const admin = requireAdmin(req)
      if (rejectLimited(res, adminAttempts(admin.id))) return true
      const body = await readJson(req, 1024)
      const hours = body?.hours ?? defaultInviteHours
      if (!Number.isInteger(hours) || hours < 1 || hours > maxInviteHours) {
        throw new RequestError(400, `Eine Einladung kann zwischen 1 und ${maxInviteHours} Stunden gültig sein.`)
      }
      json(res, 201, { invite: issueInvite(db, publicOrigin, hours, requireAdmin(req).id, false) })
      return true
    }
    const invitePath = /^\/api\/admin\/invites\/([a-f0-9-]{36})$/.exec(pathname)
    if (invitePath && req.method === 'DELETE') {
      assertOrigin(req, publicOrigin)
      requireAdmin(req)
      const revoked = db.prepare(`
        UPDATE invites SET revoked_at = ?
        WHERE id = ? AND grants_admin = 0 AND used_at IS NULL AND revoked_at IS NULL
      `).run(unixTime(), invitePath[1])
      if (!revoked.changes) throw new RequestError(404, 'Diese Einladung ist nicht mehr offen.')
      json(res, 200, { ok: true })
      return true
    }
    return false
  }

  return { handle, session, requireSession, sessionKey, isSessionActive }
}
