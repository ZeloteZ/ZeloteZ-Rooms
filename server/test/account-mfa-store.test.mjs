import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createAccountMfa, initializeAccountMfa } from '../account-mfa.mjs'
import { initializeAuthSchema } from '../auth.mjs'
import { transaction } from '../http.mjs'
import { createOwnerAccess, provisionOwnerMfa } from '../owner-access.mjs'

const publicOrigin = 'https://rooms.example.com'
const codeFormat = /^(?:[A-Z2-7]{6}-){3}[A-Z2-7]{6}$/u

function codeFor(key, seconds) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = Array.from(key, char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
  const secret = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac.at(-1) % 16
  return String((mac.readUInt32BE(offset) % 2 ** 31) % 1_000_000).padStart(6, '0')
}

function fixture(t, initialTime = 1_900_000_000) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  t.after(() => db.close())
  let now = initialTime
  t.mock.method(Date, 'now', () => now * 1000)
  initializeAuthSchema(db)
  const mfa = createAccountMfa(db, { publicOrigin })
  const addUser = (username, admin = false) => {
    const user = { id: randomUUID(), username, admin }
    db.prepare("INSERT INTO users VALUES (?,?,?,'',?,'{}','{}',?)").run(user.id, username, username, Number(admin), new Date().toISOString())
    return user
  }
  const connect = user => {
    const hash = randomBytes(32)
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash, user.id, now + 2000)
    return hash
  }
  const advance = amount => { now += amount }
  const code = key => codeFor(key, now)
  const write = change => transaction(db, change)
  return { db, mfa, addUser, connect, advance, code, write }
}

test('MFA enrollment belongs to the issuing session and can be replaced, expired, or revoked', t => {
  const { db, mfa, addUser, connect, advance, code, write } = fixture(t)
  const user = addUser('member')
  const another = addUser('other')
  const first = connect(user)
  const second = connect(user)
  assert.equal(mfa.verify(user), false)
  assert.throws(() => write(() => mfa.start(user, connect(another))), { status: 404 })

  const stale = write(() => mfa.start(user, first))
  const pending = write(() => mfa.start(user, second))
  assert.equal(pending.expiresAt, Date.now() / 1000 + 600)
  assert.equal(new URL(pending.uri).searchParams.get('secret'), pending.key)
  assert.throws(() => write(() => mfa.confirm(user, first, stale.enrollmentId, code(stale.key))), { status: 404 })
  assert.throws(() => write(() => mfa.confirm(user, first, pending.enrollmentId, code(pending.key))), { status: 404 })
  assert.throws(() => write(() => mfa.confirm(user, second, pending.enrollmentId, 'invalid')), { status: 403, code: 'ROOMS_MFA_CODE' })
  assert.deepEqual(mfa.status(user), { enabled: false, required: false, recoveryCodesRemaining: 0 })
  advance(600)
  assert.throws(() => write(() => mfa.confirm(user, second, pending.enrollmentId, code(pending.key))), { status: 404 })

  const abandoned = write(() => mfa.start(user, first))
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(first)
  assert.throws(() => write(() => mfa.confirm(user, first, abandoned.enrollmentId, code(abandoned.key))), { status: 404 })
  assert.equal(db.prepare('SELECT 1 FROM account_mfa_pending WHERE user_id = ?').get(user.id), undefined)
  const active = write(() => mfa.start(user, second))
  assert.equal(write(() => mfa.confirm(user, second, active.enrollmentId, code(active.key))).length, 10)
  assert.throws(() => write(() => mfa.confirm(user, second, active.enrollmentId, code(active.key))), { status: 404 })
  assert.deepEqual(mfa.status(user), { enabled: true, required: false, recoveryCodesRemaining: 10 })
})

test('recovery codes are hashed, single-use, rotatable and removed when member MFA is disabled', t => {
  const { db, mfa, addUser, connect, code, write } = fixture(t)
  const user = addUser('member')
  const session = connect(user)
  const active = write(() => mfa.start(user, session))
  const codes = write(() => mfa.confirm(user, session, active.enrollmentId, code(active.key)))
  assert.equal(new Set(codes).size, 10)
  for (const value of codes) assert.match(value, codeFormat)
  const expectedHashes = codes.map(value => createHash('sha256').update(value.replaceAll('-', '')).digest('hex')).sort()
  const stored = db.prepare('SELECT lower(hex(code_hash)) AS hash FROM account_mfa_recovery_codes WHERE user_id = ? ORDER BY hash').all(user.id)
  assert.deepEqual(stored.map(row => row.hash), expectedHashes)

  assert.throws(() => write(() => mfa.verify(user, codes[0], { allowRecovery: false })), { status: 403, code: 'ROOMS_MFA_CODE' })
  assert.throws(() => write(() => {
    assert.equal(mfa.verify(user, codes[0]), true)
    throw new Error('Canceled transaction')
  }), /Canceled transaction/u)
  assert.equal(mfa.status(user).recoveryCodesRemaining, 10)
  assert.equal(write(() => mfa.verify(user, codes[0].toLowerCase())), true)
  assert.equal(mfa.status(user).recoveryCodesRemaining, 9)
  assert.throws(() => write(() => mfa.verify(user, codes[0])), { status: 403, code: 'ROOMS_MFA_CODE' })

  const renewed = write(() => mfa.rotateRecoveryCodes(user))
  assert.throws(() => write(() => mfa.verify(user, codes[1])), { status: 403, code: 'ROOMS_MFA_CODE' })
  assert.equal(write(() => mfa.verify(user, renewed[0])), true)
  write(() => mfa.disable(user))
  assert.deepEqual(mfa.status(user), { enabled: false, required: false, recoveryCodesRemaining: 0 })
  assert.equal(db.prepare('SELECT count(*) AS total FROM account_mfa_recovery_codes WHERE user_id = ?').get(user.id).total, 0)
})

test('existing owner seed and replay state persist, and CLI reclaim revokes MFA codes only after preparation succeeds', t => {
  const { db, mfa, addUser, connect, write } = fixture(t, 59)
  const user = addUser('owner', true)
  const session = connect(user)
  // RFC 6238 SHA-1 secret, counter 1 and six-digit suffix of the test code at 59 seconds.
  const key = Buffer.from('12345678901234567890')
  db.prepare('INSERT INTO owner_mfa VALUES (?,?,?)').run(user.id, key, 1)
  initializeAccountMfa(db)
  const access = createOwnerAccess(db, { mfa })
  assert.deepEqual(mfa.status(user), { enabled: true, required: true, recoveryCodesRemaining: 0 })
  assert.throws(() => write(() => access.verifyFactor(user.id, '287082')), { status: 403, code: 'ROOMS_OWNER_CODE' })
  assert.throws(() => write(() => mfa.disable(user)), { status: 403 })
  const codes = write(() => mfa.rotateRecoveryCodes(user))
  assert.throws(() => write(() => access.verifyFactor(user.id, codes[0])), { status: 403, code: 'ROOMS_OWNER_CODE' })
  write(() => mfa.start(user, session))

  assert.throws(() => provisionOwnerMfa(db, publicOrigin, () => { throw new Error('Prepare failed') }), /Prepare failed/u)
  const readOwner = db.prepare('SELECT secret, last_step FROM owner_mfa WHERE user_id = ?')
  assert.deepEqual(Buffer.from(readOwner.get(user.id).secret), key)
  assert.equal(readOwner.get(user.id).last_step, 1)
  assert.equal(mfa.status(user).recoveryCodesRemaining, 10)
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(session))

  let prepared
  const reclaimed = provisionOwnerMfa(db, publicOrigin, enrollment => { prepared = enrollment })
  assert.deepEqual(prepared, reclaimed)
  assert.notDeepEqual(Buffer.from(readOwner.get(user.id).secret), key)
  assert.equal(readOwner.get(user.id).last_step, -1)
  assert.deepEqual(mfa.status(user), { enabled: true, required: true, recoveryCodesRemaining: 0 })
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(session), undefined)
  assert.equal(db.prepare('SELECT 1 FROM account_mfa_pending WHERE user_id = ?').get(user.id), undefined)
})
