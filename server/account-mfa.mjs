import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { RequestError } from './http.mjs'

const enrollmentLifetime = 10 * 60
const recoveryCodeCount = 10
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const time = () => Math.floor(Date.now() / 1000)
const digest = value => createHash('sha256').update(value).digest()

export function initializeAccountMfa(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret BLOB NOT NULL,
      last_step INTEGER NOT NULL DEFAULT -1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret BLOB NOT NULL CHECK (length(secret) = 20),
      last_step INTEGER NOT NULL DEFAULT -1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_mfa_pending (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      session_hash BLOB NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      enrollment_id TEXT NOT NULL,
      secret BLOB NOT NULL CHECK (length(secret) = 20),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS account_mfa_pending_session ON account_mfa_pending(session_hash);
    CREATE INDEX IF NOT EXISTS account_mfa_pending_expiry ON account_mfa_pending(expires_at);
    CREATE TABLE IF NOT EXISTS account_mfa_recovery_codes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash BLOB NOT NULL CHECK (length(code_hash) = 32),
      PRIMARY KEY (user_id, code_hash)
    ) STRICT, WITHOUT ROWID;
  `)
}

function base32(bytes) {
  let key = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      key += base32Alphabet[(value >>> bits) & 31]
    }
  }
  return bits ? key + base32Alphabet[(value << (5 - bits)) & 31] : key
}

function enrollmentFor(publicOrigin, username, secret) {
  const key = base32(secret)
  const issuer = 'ZeloteZ Rooms ' + new URL(publicOrigin).host
  const parameters = new URLSearchParams({ secret: key, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return { key, uri: 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(username) + '?' + parameters }
}

function totp(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  return Buffer.from(String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0'))
}

export const isTotpCode = code => typeof code === 'string' && code.length === 6 && /^[0-9]{6}$/u.test(code)

function matchingStep(secret, code, now, lastStep = -1) {
  if (!isTotpCode(code)) return null
  const input = Buffer.from(code)
  const current = Math.floor(now / 30)
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && step > lastStep && timingSafeEqual(input, totp(secret, step))) return step
  }
  return null
}

function recoveryCode(code) {
  if (typeof code !== 'string' || code.length > 40) return null
  const normalized = code.trim().toUpperCase().replaceAll('-', '')
  return normalized.length === 24 && /^[A-Z2-7]{24}$/u.test(normalized) ? normalized : null
}

function invalidCode(user, allowRecovery) {
  const message = allowRecovery
    ? 'Gib einen aktuellen Code aus deiner Authenticator-App oder einen Wiederherstellungscode ein.'
    : 'Gib einen aktuellen Code aus deiner Authenticator-App ein.'
  const error = new RequestError(403, message)
  error.code = user.admin ? 'ROOMS_OWNER_CODE' : 'ROOMS_MFA_CODE'
  return error
}

const missingEnrollment = () => new RequestError(404, 'Diese Zwei-Faktor-Einrichtung ist abgelaufen. Starte sie erneut.')

function factorQueries(db, table) {
  return {
    active: db.prepare(`SELECT secret, last_step FROM ${table} WHERE user_id = ?`),
    configured: db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ?`),
    advance: db.prepare(`UPDATE ${table} SET last_step = ? WHERE user_id = ? AND last_step < ?`),
    install: db.prepare(`INSERT INTO ${table}(user_id, secret, last_step) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, last_step = excluded.last_step`),
  }
}

export function createAccountMfa(db, { publicOrigin } = {}) {
  const owner = factorQueries(db, 'owner_mfa')
  const member = factorQueries(db, 'account_mfa')
  const factors = user => user.admin ? owner : member
  const removeMember = db.prepare('DELETE FROM account_mfa WHERE user_id = ?')
  const deleteCodes = db.prepare('DELETE FROM account_mfa_recovery_codes WHERE user_id = ?')
  const insertCode = db.prepare('INSERT INTO account_mfa_recovery_codes(user_id, code_hash) VALUES (?,?)')
  const deleteCode = db.prepare('DELETE FROM account_mfa_recovery_codes WHERE user_id = ? AND code_hash = ?')
  const countCodes = db.prepare('SELECT count(*) AS total FROM account_mfa_recovery_codes WHERE user_id = ?')
  const putPending = db.prepare(`INSERT INTO account_mfa_pending(user_id, session_hash, enrollment_id, secret, expires_at)
    SELECT user_id, token_hash, ?, ?, ? FROM sessions WHERE user_id = ? AND token_hash = ? AND expires_at > ?
    ON CONFLICT(user_id) DO UPDATE SET session_hash = excluded.session_hash, enrollment_id = excluded.enrollment_id,
      secret = excluded.secret, expires_at = excluded.expires_at`)
  const pending = db.prepare(`SELECT p.secret FROM account_mfa_pending p JOIN sessions s ON s.token_hash = p.session_hash
    AND s.user_id = p.user_id AND s.expires_at > ?
    WHERE p.user_id = ? AND p.session_hash = ? AND p.enrollment_id = ? AND p.expires_at > ?`)
  const deletePending = db.prepare('DELETE FROM account_mfa_pending WHERE user_id = ?')
  const prunePending = db.prepare('DELETE FROM account_mfa_pending WHERE expires_at <= ?')

  function configured(user) {
    return Boolean(factors(user).configured.get(user.id))
  }

  function status(user) {
    const enabled = configured(user)
    return { enabled, required: Boolean(user.admin), recoveryCodesRemaining: enabled ? countCodes.get(user.id).total : 0 }
  }

  function verify(user, code, { allowRecovery = true } = {}) {
    const factor = factors(user)
    const active = factor.active.get(user.id)
    if (!active) return false
    const step = matchingStep(active.secret, code, time(), active.last_step)
    if (step !== null && factor.advance.run(step, user.id, step).changes) return true
    const recovery = allowRecovery && recoveryCode(code)
    if (recovery && deleteCode.run(user.id, digest(recovery)).changes) return true
    throw invalidCode(user, allowRecovery)
  }

  function start(user, sessionHash) {
    const enrollmentId = randomUUID()
    const secret = randomBytes(20)
    const now = time()
    const expiresAt = now + enrollmentLifetime
    const enrollment = enrollmentFor(publicOrigin, user.username, secret)
    prunePending.run(now)
    if (!putPending.run(enrollmentId, secret, expiresAt, user.id, sessionHash, now).changes) throw missingEnrollment()
    return { enrollmentId, ...enrollment, expiresAt }
  }

  function rotateRecoveryCodes(user) {
    if (!configured(user)) throw new RequestError(403, 'Richte zuerst die Zwei-Faktor-Anmeldung ein.')
    deleteCodes.run(user.id)
    return Array.from({ length: recoveryCodeCount }, () => {
      const code = base32(randomBytes(15))
      insertCode.run(user.id, digest(code))
      return code.match(/.{6}/g).join('-')
    })
  }

  function confirm(user, sessionHash, enrollmentId, code) {
    const now = time()
    const enrollment = typeof enrollmentId === 'string' && pending.get(now, user.id, sessionHash, enrollmentId, now)
    if (!enrollment) throw missingEnrollment()
    const step = matchingStep(enrollment.secret, code, now)
    if (step === null) throw invalidCode(user, false)
    factors(user).install.run(user.id, enrollment.secret, step)
    deletePending.run(user.id)
    return rotateRecoveryCodes(user)
  }

  function disable(user) {
    if (user.admin) throw new RequestError(403, 'Das Betreiberkonto benötigt die Zwei-Faktor-Anmeldung.')
    removeMember.run(user.id)
    deletePending.run(user.id)
    deleteCodes.run(user.id)
  }

  function reclaimOwner(user, prepare) {
    const secret = randomBytes(20)
    const enrollment = enrollmentFor(publicOrigin, user.username, secret)
    prepare?.(enrollment)
    owner.install.run(user.id, secret, -1)
    deletePending.run(user.id)
    deleteCodes.run(user.id)
    return enrollment
  }

  // Callers wrap updates that touch multiple rows and credential changes in their transaction.
  return { status, verify, start, confirm, disable, rotateRecoveryCodes, configured, reclaimOwner }
}
