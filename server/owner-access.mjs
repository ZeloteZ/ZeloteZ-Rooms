import { createHash, randomBytes } from 'node:crypto'
import { createAccountMfa, initializeAccountMfa } from './account-mfa.mjs'
import { transaction } from './http.mjs'

const now = () => Math.floor(Date.now() / 1000)
const approvalLifetime = 5 * 60
const recoveryLifetime = 20 * 60
const digest = value => createHash('sha256').update(value).digest()

export function initializeOwnerAccess(db) {
  initializeAccountMfa(db)
  db.exec(`
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

export function provisionOwnerMfa(db, origin, prepare) {
  const mfa = createAccountMfa(db, { publicOrigin: origin })
  return transaction(db, () => {
    const owner = siteOwner(db)
    const enrollment = mfa.reclaimOwner(owner, prepare)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id)
    return enrollment
  })
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

export function createOwnerAccess(db, { mfa = createAccountMfa(db) } = {}) {
  const approval = db.prepare('SELECT expires_at FROM owner_approvals WHERE session_hash = ? AND expires_at > ?')
  const approve = db.prepare(`INSERT INTO owner_approvals(session_hash, expires_at) VALUES (?,?)
    ON CONFLICT(session_hash) DO UPDATE SET expires_at = excluded.expires_at`)
  const recoveryPending = db.prepare('SELECT 1 FROM owner_recovery WHERE user_id = ?')
  const recoverable = db.prepare(`SELECT u.* FROM owner_recovery r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.expires_at > ? AND u.admin = 1`)
  const consumeRecovery = db.prepare('DELETE FROM owner_recovery WHERE user_id = ?')

  return {
    configured: id => mfa.configured({ id, admin: true }),
    verifyFactor: (id, code) => mfa.verify({ id, admin: true }, code, { allowRecovery: false }),
    approvedUntil: token => token ? (approval.get(digest(token), now())?.expires_at ?? 0) : 0,
    approve: (tokenHash, expiresAt = now() + approvalLifetime) => approve.run(tokenHash, expiresAt),
    recoveryPending: userId => Boolean(recoveryPending.get(userId)),
    recoverable: token => recoverable.get(digest(token), now()),
    consumeRecovery: userId => consumeRecovery.run(userId),
  }
}
