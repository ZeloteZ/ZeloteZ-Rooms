import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { RequestError, transaction } from './http.mjs'

const now = () => Math.floor(Date.now() / 1000)
const approvalLifetime = 5 * 60
const recoveryLifetime = 20 * 60
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const digest = value => createHash('sha256').update(value).digest()

export function initializeOwnerAccess(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret BLOB NOT NULL,
      last_step INTEGER NOT NULL DEFAULT -1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS owner_approvals (
      session_hash BLOB PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS owner_recovery (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_hash BLOB NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    ) STRICT;
  `)
}

function siteOwner(db) {
  const owner = db.prepare('SELECT id, username FROM users WHERE admin = 1').get()
  if (!owner) throw new Error('Create the site owner account first.')
  return owner
}

export function provisionOwnerMfa(db, origin) {
  const secret = randomBytes(20)
  // Twenty bytes are a whole number of five-bit Base32 symbols.
  let key = ''
  let value = 0
  let bits = 0
  for (const byte of secret) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      key += base32Alphabet[(value >>> bits) & 31]
    }
  }
  const owner = transaction(db, () => {
    const owner = siteOwner(db)
    db.prepare(`INSERT INTO owner_mfa(user_id, secret) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, last_step = -1`).run(owner.id, secret)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id)
    return owner
  })
  const issuer = 'ZeloteZ Rooms ' + new URL(origin).host
  const parameters = new URLSearchParams({ secret: key, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return { key, uri: 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(owner.username) + '?' + parameters }
}

export function issueOwnerRecovery(db, origin) {
  const token = randomBytes(32).toString('base64url')
  transaction(db, () => {
    const { id } = siteOwner(db)
    const time = now()
    db.prepare(`INSERT INTO owner_recovery(user_id, token_hash, expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`)
      .run(id, digest(token), time + recoveryLifetime)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    db.prepare('UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL').run(time, id)
  })
  const url = new URL('/', origin)
  url.hash = 'recover=' + token
  return url.href
}

function totp(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  return Buffer.from(String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0'))
}

export function createOwnerAccess(db) {
  const factor = db.prepare('SELECT secret, last_step FROM owner_mfa WHERE user_id = ?')
  const advance = db.prepare('UPDATE owner_mfa SET last_step = ? WHERE user_id = ? AND last_step < ?')
  const approval = db.prepare('SELECT expires_at FROM owner_approvals WHERE session_hash = ? AND expires_at > ?')
  const approve = db.prepare(`INSERT INTO owner_approvals(session_hash, expires_at) VALUES (?,?)
    ON CONFLICT(session_hash) DO UPDATE SET expires_at = excluded.expires_at`)
  const recoveryPending = db.prepare('SELECT 1 FROM owner_recovery WHERE user_id = ?')
  const recoverable = db.prepare(`SELECT u.* FROM owner_recovery r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.expires_at > ? AND u.admin = 1`)
  const consumeRecovery = db.prepare('DELETE FROM owner_recovery WHERE user_id = ?')

  function verifyFactor(userId, code) {
    const row = factor.get(userId)
    if (!row) return false
    const step = Math.floor(now() / 30)
    if (typeof code === 'string' && code.length === 6 && /^\d{6}$/.test(code)) {
      const input = Buffer.from(code)
      for (const candidate of [step, step - 1, step + 1]) {
        if (candidate > row.last_step && timingSafeEqual(input, totp(row.secret, candidate)) &&
            advance.run(candidate, userId, candidate).changes) return true
      }
    }
    const error = new RequestError(403, 'Gib einen aktuellen Code aus deiner Authenticator-App ein.')
    error.code = 'ROOMS_OWNER_CODE'
    throw error
  }

  return {
    configured: userId => Boolean(factor.get(userId)),
    verifyFactor,
    approvedUntil: token => token ? (approval.get(digest(token), now())?.expires_at ?? 0) : 0,
    approve: (tokenHash, expiresAt = now() + approvalLifetime) => approve.run(tokenHash, expiresAt),
    recoveryPending: userId => Boolean(recoveryPending.get(userId)),
    recoverable: token => recoverable.get(digest(token), now()),
    consumeRecovery: userId => consumeRecovery.run(userId),
  }
}
