import { createHash, createPublicKey, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import { assertOrigin, json, readJson, RequestError, transaction } from './http.mjs'
import { createOwnerAccess, initializeOwnerAccess } from './owner-access.mjs'
import { createAuthWork } from './auth-work.mjs'

const secondsPerHour = 3600
const sessionLifetime = 7 * 24 * secondsPerHour
const defaultInviteHours = 48
const maxInviteHours = 168
const accountsPerPage = 100
const accountsRestricted = 'Nur der Betreiber kann Konten verwalten.'
const hashVersion = 'scrypt-v1'
const scryptOptions = { N: 2 ** 16, r: 8, p: 2, maxmem: 96 * 1024 ** 2 }
const scryptAsync = promisify(scrypt)
const derivePasswordKey = (credential, salt) => scryptAsync(Buffer.from(credential, 'base64url'), salt, 32, scryptOptions)
const dummyHash = [hashVersion, randomBytes(16).toString('base64url'), randomToken()].join('$')
const unixTime = () => Math.floor(Date.now() / 1000)
const timestamp = value => value === null ? null : new Date(value * 1000).toISOString()
const digest = value => createHash('sha256').update(value).digest()
const passwordHashFor = (salt, key) => [hashVersion, salt.toString('base64url'), key.toString('base64url')].join('$')

function passwordHashParts(hash) {
  const [version, salt, expected] = hash.split('$')
  if (version !== hashVersion || !base64url(salt, 22) || !base64url(expected, 43)) {
    throw new Error('Ungültiger Passwort-Hash in der Datenbank.')
  }
  return [Buffer.from(salt, 'base64url'), Buffer.from(expected, 'base64url')]
}

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
  initializeOwnerAccess(db)
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

export function requestAddress(req, trustProxyIp) {
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
      // Bound tracking without denying every new client when the table fills up.
      if (entry) attempts.delete(key)
      else if (attempts.size >= maxTrackedClients) attempts.delete(attempts.keys().next().value)
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
  const owner = createOwnerAccess(db)
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
  const updateCredentials = db.prepare('UPDATE users SET password_hash = ?, identity = ? WHERE id = ?')
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
  const nameAttempts = attemptLimit(8, 120)
  const inviteAttempts = attemptLimit(10, 60)
  const adminAttempts = attemptLimit(24, 60)
  const credentialAttempts = attemptLimit(8, 60)
  const recoveryAttempts = attemptLimit(16, 60)
  const codeAttempts = attemptLimit(12, 60)
  const runPasswordWork = createAuthWork()

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

  function requireAdmin(req, { configured = true, approved = false } = {}) {
    const user = requireSession(req)
    if (!user.admin) throw new RequestError(403, accountsRestricted)
    if (configured && !owner.configured(user.id)) {
      throw new RequestError(403, 'Richte zuerst die Zwei-Faktor-Anmeldung für das Betreiberkonto ein.')
    }
    if (approved && !owner.approvedUntil(sessionToken(req))) {
      const error = new RequestError(403, 'Bestätige den Betreiberzugriff mit einem aktuellen Authenticator-Code.')
      error.code = 'ROOMS_OWNER_APPROVAL'
      throw error
    }
    return user
  }

  function startSession(req, userId, { factorVerified = false, approvedUntil = 0 } = {}) {
    if (accountDisabled.get(userId)) throw invalidLogin()
    const previousToken = sessionToken(req)
    const token = randomToken()
    const now = unixTime()
    pruneSessions.run(now)
    if (previousToken) deleteSession.run(digest(previousToken))
    limitSessions.run(userId)
    const tokenHash = digest(token)
    insertSession.run(tokenHash, userId, now + sessionLifetime)
    if (factorVerified) owner.approve(tokenHash)
    else if (approvedUntil) owner.approve(tokenHash, approvedUntil)
    return `${cookieName}=${token}; ${cookieFlags}; Max-Age=${sessionLifetime}`
  }

  function passwordKey(credential, salt, access) {
    return runPasswordWork(access, () => derivePasswordKey(credential, salt))
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
    const [salt, expected] = passwordHashParts(row?.password_hash ?? dummyHash)
    const actual = await passwordKey(body.password, salt, { lane: 'login', ip, subject: username, response: res })
    if (!actual) return
    if (!timingSafeEqual(actual, expected) || !row) throw invalidLogin()
    if (row.admin === 1 && body.code !== undefined && rejectLimited(res, codeAttempts('login:' + row.id))) return

    const result = transaction(db, () => {
      const current = selectLogin.get(username)
      if (current?.id !== row.id || current.password_hash !== row.password_hash || owner.recoveryPending(row.id)) throw invalidLogin()
      if (current.admin === 1 && !owner.configured(row.id)) {
        throw new RequestError(403, 'Richte zuerst die Zwei-Faktor-Anmeldung für das Betreiberkonto ein.')
      }
      const factorVerified = current.admin === 1 && owner.verifyFactor(row.id, body.code)
      return { user: present(toUser(current)), cookie: startSession(req, row.id, { factorVerified }) }
    })
    json(res, 200, { user: result.user }, { 'Set-Cookie': result.cookie })
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
    const invitation = redeemableInvite.get(inviteHash, unixTime())
    if (!invitation) throw invalidInvite()
    const publicKey = cleanPublicKey(body.publicKey)
    const identity = cleanIdentity(body.identity)
    if (!publicKey || !identity) throw new RequestError(400, 'Der Schlüssel für den verschlüsselten Chat ist ungültig.')

    const salt = randomBytes(16)
    const key = await passwordKey(body.password, salt, { lane: 'registration', ip, subject: invitation.id, response: res })
    if (!key) return
    const passwordHash = passwordHashFor(salt, key)
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

  async function changePassword(req, res) {
    const actor = requireSession(req)
    const approvedUntil = () => {
      if (!actor.admin) return 0
      requireAdmin(req, { approved: true })
      return owner.approvedUntil(sessionToken(req))
    }
    approvedUntil()
    if (rejectLimited(res, credentialAttempts(actor.id))) return
    const body = await readJson(req, 4096)
    const identity = cleanIdentity(body.identity)
    if (!identity || !base64url(body.current, 43) || !base64url(body.password, 43)) {
      throw new RequestError(400, 'Das Passwort oder der Chatschlüssel konnte nicht verarbeitet werden.')
    }
    if (requireSession(req).id !== actor.id) throw invalidLogin()
    approvedUntil()
    const row = selectLogin.get(actor.username)
    const [salt, expected] = passwordHashParts(row.password_hash)
    const newSalt = randomBytes(16)
    const ip = requestAddress(req, trustProxyIp)
    const key = await runPasswordWork({ lane: 'registration', ip, subject: 'password:' + actor.id, response: res }, async () => {
      const current = await derivePasswordKey(body.current, salt)
      if (!timingSafeEqual(current, expected)) throw new RequestError(403, 'Das aktuelle Passwort stimmt nicht.')
      return derivePasswordKey(body.password, newSalt)
    })
    if (!key) return
    const result = transaction(db, () => {
      if (requireSession(req).id !== actor.id || selectLogin.get(actor.username).password_hash !== row.password_hash) {
        throw new RequestError(409, 'Das Konto wurde inzwischen geändert. Melde dich erneut an.')
      }
      const until = approvedUntil()
      updateCredentials.run(passwordHashFor(newSalt, key), JSON.stringify(identity), actor.id)
      deleteAccountSessions.run(actor.id)
      revokeBroadcasts(actor.id)
      return { user: present(toUser(selectLogin.get(actor.username))), cookie: startSession(req, actor.id, { approvedUntil: until }) }
    })
    json(res, 200, { user: result.user }, { 'Set-Cookie': result.cookie })
  }

  async function recoverOwner(req, res, complete) {
    const ip = requestAddress(req, trustProxyIp)
    if (rejectLimited(res, recoveryAttempts(ip))) return
    const body = await readJson(req, 4096)
    const invalidRecovery = () => new RequestError(404, 'Der Wiederherstellungslink ist ungültig oder abgelaufen.')
    const find = () => base64url(body.token, 43) && owner.recoverable(body.token)
    const row = find()
    if (!row) throw invalidRecovery()
    if (!complete) return json(res, 200, { user: toUser(row) })

    const identity = body.keepLocked === true && body.identity === undefined
      ? { ...JSON.parse(row.identity), detached: true } : cleanIdentity(body.identity)
    if (!identity || !base64url(body.password, 43)) throw new RequestError(400, 'Das Passwort oder der Chatschlüssel konnte nicht verarbeitet werden.')
    const salt = randomBytes(16)
    const key = await passwordKey(body.password, salt, { lane: 'registration', ip, subject: 'password:' + row.id, response: res })
    if (!key) return
    transaction(db, () => {
      if (!find()) throw invalidRecovery()
      updateCredentials.run(passwordHashFor(salt, key), JSON.stringify(identity), row.id)
      owner.consumeRecovery(row.id)
      deleteAccountSessions.run(row.id)
      revokeBroadcasts(row.id)
    })
    res.writeHead(204).end()
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
    if (pathname === '/api/auth/password' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      await changePassword(req, res)
      return true
    }
    if (['/api/auth/recovery', '/api/auth/recovery/complete'].includes(pathname) && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      await recoverOwner(req, res, pathname.endsWith('/complete'))
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
    if (pathname === '/api/admin/security' && req.method === 'GET') {
      const admin = requireAdmin(req, { configured: false })
      json(res, 200, { configured: owner.configured(admin.id), approvedUntil: owner.approvedUntil(sessionToken(req)) })
      return true
    }
    if (pathname === '/api/admin/authorize' && req.method === 'POST') {
      assertOrigin(req, publicOrigin)
      const admin = requireAdmin(req)
      if (rejectLimited(res, codeAttempts(admin.id))) return true
      const { code } = await readJson(req, 1024)
      const token = sessionToken(req)
      transaction(db, () => {
        if (requireAdmin(req).id !== admin.id) throw invalidLogin()
        owner.verifyFactor(admin.id, code)
        owner.approve(digest(token))
      })
      json(res, 200, { approvedUntil: owner.approvedUntil(token) })
      return true
    }
    if (pathname === '/api/admin/accounts' && req.method === 'GET') {
      requireAdmin(req)
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
      const admin = requireAdmin(req, { approved: true })
      if (rejectLimited(res, adminAttempts(admin.id))) return true
      const body = await readJson(req, 1024)
      if (Object.keys(body).length !== 1 || (typeof body.disabled !== 'boolean' && body.revokeSessions !== true)) {
        throw new RequestError(400, 'Ungültige Auswahl.')
      }
      const id = accountPath[1]
      const account = transaction(db, () => {
        requireAdmin(req, { approved: true })
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
      const admin = requireAdmin(req, { approved: true })
      if (rejectLimited(res, adminAttempts(admin.id))) return true
      const body = await readJson(req, 1024)
      const hours = body?.hours ?? defaultInviteHours
      if (!Number.isInteger(hours) || hours < 1 || hours > maxInviteHours) {
        throw new RequestError(400, `Eine Einladung kann zwischen 1 und ${maxInviteHours} Stunden gültig sein.`)
      }
      json(res, 201, { invite: issueInvite(db, publicOrigin, hours, requireAdmin(req, { approved: true }).id, false) })
      return true
    }
    const invitePath = /^\/api\/admin\/invites\/([a-f0-9-]{36})$/.exec(pathname)
    if (invitePath && req.method === 'DELETE') {
      assertOrigin(req, publicOrigin)
      const admin = requireAdmin(req, { approved: true })
      if (rejectLimited(res, adminAttempts(admin.id))) return true
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
