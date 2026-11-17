import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { bootstrapOwnerInvite, createAuth } from '../auth.mjs'
import { issueOwnerRecovery, provisionOwnerMfa } from '../owner-access.mjs'

const origin = 'https://rooms.example.com'
const encoded = size => randomBytes(size).toString('base64url')
const newIdentity = () => ({ v: 1, nonce: encoded(12), blob: encoded(64) })

// Authenticator-style calculation using the exported Base32 provisioning key.
function authenticatorCode(key, seconds) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...key].map(symbol => alphabet.indexOf(symbol).toString(2).padStart(5, '0')).join('')
  const secret = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)))
  const hmac = createHmac('sha1', secret).update(counter).digest()
  const offset = hmac.at(-1) % 16
  const number = (hmac[offset] % 128) * 2 ** 24 + hmac[offset + 1] * 2 ** 16 + hmac[offset + 2] * 256 + hmac[offset + 3]
  return String(number % 1_000_000).padStart(6, '0')
}

async function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  t.after(() => db.close())
  let seconds = 1_900_000_010
  t.mock.method(Date, 'now', () => seconds * 1000)
  const revoked = []
  const auth = createAuth(db, { publicOrigin: origin, revokeBroadcasts: id => revoked.push(id) })

  async function request(method, path, body, cookie) {
    const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    input.method = method
    input.url = '/api/' + path
    input.socket = { remoteAddress: '127.0.0.1' }
    input.headers = { origin, cookie, ...(body !== undefined && { 'content-type': 'application/json' }) }
    const chunks = []
    const response = new Writable({ write(data, _encoding, done) { chunks.push(data); done() } })
    const headers = {}
    let status
    response.setHeader = (name, value) => { headers[name] = value }
    response.writeHead = (value, more) => { status = value; Object.assign(headers, more); return response }
    assert.equal(await auth.handle(input, response, new URL(input.url, origin).pathname), true)
    return { status, cookie: headers['Set-Cookie']?.split(';', 1)[0], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined }
  }

  const username = 'site-owner'
  const password = encoded(32)
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  const identity = newIdentity()
  const { url } = bootstrapOwnerInvite(db, origin)
  const invite = new URLSearchParams(new URL(url).hash.slice(1)).get('invite')
  const registered = await request('POST', 'auth/register', { username, displayName: 'Owner', password, publicKey, identity, invite })
  assert.equal(registered.status, 201)
  assert.equal(registered.body.user.admin, true)
  const login = (code, credential = password) => request('POST', 'auth/login', { username, password: credential, code })
  const session = async cookie => (await request('GET', 'auth/session', undefined, cookie)).body.user
  const tick = amount => { seconds += amount }
  const provision = () => {
    const { key, uri } = provisionOwnerMfa(db, origin)
    const enrollment = new URL(uri)
    assert.equal(enrollment.protocol, 'otpauth:')
    assert.equal(enrollment.host, 'totp')
    assert.equal(enrollment.searchParams.get('secret'), key)
    assert.equal(enrollment.searchParams.get('digits'), '6')
    assert.equal(enrollment.searchParams.get('period'), '30')
    assert.match(key, /^[A-Z2-7]{32}$/u)
    return (offset = 0) => authenticatorCode(key, seconds + offset)
  }
  const issueRecovery = () => {
    const url = new URL(issueOwnerRecovery(db, origin))
    assert.equal(url.origin, origin)
    assert.equal(url.search, '')
    const token = new URLSearchParams(url.hash.slice(1)).get('recover')
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
    return token
  }
  return { db, request, password, publicKey, identity, registered, login, session, tick, provision, issueRecovery, revoked }
}

test('legacy owner access requires local TOTP setup and sensitive actions require fresh approval', async t => {
  const { request, registered, login, session, tick, provision } = await fixture(t)
  assert.deepEqual((await request('GET', 'admin/security', undefined, registered.cookie)).body,
    { configured: false, approvedUntil: 0 })
  await assert.rejects(request('GET', 'admin/accounts', undefined, registered.cookie), { status: 403 })
  await assert.rejects(login(), { status: 403 })

  const code = provision()
  const codeForReplayCheck = () => {
    // The next time step is allowed for clock skew. Skip a coincidental numerical match.
    while (code() === code(30)) tick(30)
    return code()
  }
  assert.equal(await session(registered.cookie), null)
  await assert.rejects(login(), { status: 403, code: 'ROOMS_OWNER_CODE' })
  const initialCode = codeForReplayCheck()
  const signedIn = await login(initialCode)
  assert.equal(signedIn.status, 200)
  await assert.rejects(login(initialCode), { status: 403, code: 'ROOMS_OWNER_CODE' })
  const { body: initial } = await request('GET', 'admin/security', undefined, signedIn.cookie)
  assert.equal(initial.configured, true)
  assert.ok(initial.approvedUntil > Date.now() / 1000)

  tick(301)
  await assert.rejects(request('POST', 'admin/invites', {}, signedIn.cookie), { status: 403, code: 'ROOMS_OWNER_APPROVAL' })
  await assert.rejects(request('POST', 'auth/password', {}, signedIn.cookie), { status: 403, code: 'ROOMS_OWNER_APPROVAL' })
  await assert.rejects(request('POST', 'admin/authorize', {}, signedIn.cookie), { status: 403, code: 'ROOMS_OWNER_CODE' })
  const freshCode = codeForReplayCheck()
  const approved = await request('POST', 'admin/authorize', { code: freshCode }, signedIn.cookie)
  assert.equal(approved.status, 200)
  assert.ok(approved.body.approvedUntil > initial.approvedUntil)
  assert.equal((await request('POST', 'admin/invites', {}, signedIn.cookie)).status, 201)
  await assert.rejects(request('POST', 'admin/authorize', { code: freshCode }, signedIn.cookie), { status: 403, code: 'ROOMS_OWNER_CODE' })
})

test('owner password changes retain the public identity and rotate all sessions', async t => {
  const { request, publicKey, password, login, session, tick, provision, revoked } = await fixture(t)
  const code = provision()
  const first = await login(code())
  tick(30)
  const second = await login(code())
  const rotated = encoded(32)
  const identity = newIdentity()
  await assert.rejects(request('POST', 'auth/password', { current: encoded(32), password: rotated, identity }, first.cookie), { status: 403 })
  assert.ok(await session(second.cookie))
  const changed = await request('POST', 'auth/password', { current: password, password: rotated, identity }, first.cookie)
  assert.equal(changed.status, 200)
  assert.notEqual(changed.cookie, first.cookie)
  assert.deepEqual(changed.body.user.publicKey, publicKey)
  assert.deepEqual(changed.body.user.identity, identity)
  assert.equal(await session(first.cookie), null)
  assert.equal(await session(second.cookie), null)
  assert.deepEqual(await session(changed.cookie), changed.body.user)
  assert.deepEqual(revoked, [changed.body.user.id])

  tick(30)
  await assert.rejects(login(code(), password), { status: 401 })
  assert.equal((await login(code(), rotated)).status, 200)
})

test('local owner recovery locks sign-in, revokes invites, and preserves the detached chat identity', async t => {
  const { db, request, publicKey, identity, login, session, tick, provision, issueRecovery, revoked } = await fixture(t)
  const code = provision()
  const original = await login(code())
  const { body: { invite } } = await request('POST', 'admin/invites', {}, original.cookie)
  const first = issueRecovery()
  assert.equal(await session(original.cookie), null)
  assert.ok(db.prepare('SELECT revoked_at FROM invites WHERE id = ?').get(invite.id).revoked_at)
  tick(30)
  await assert.rejects(login(code()), { status: 401 })
  const detail = await request('POST', 'auth/recovery', { token: first })
  assert.equal(detail.status, 200)
  assert.equal(detail.cookie, undefined)
  assert.deepEqual(detail.body.user.identity, identity)

  const expired = issueRecovery()
  await assert.rejects(request('POST', 'auth/recovery', { token: first }), { status: 404 })
  tick(1201)
  await assert.rejects(request('POST', 'auth/recovery', { token: expired }), { status: 404 })
  const token = issueRecovery()
  const recovered = encoded(32)
  const completed = await request('POST', 'auth/recovery/complete', { token, password: recovered, keepLocked: true })
  assert.equal(completed.status, 204)
  assert.equal(completed.cookie, undefined)
  await assert.rejects(request('POST', 'auth/recovery/complete', { token, password: recovered, keepLocked: true }), { status: 404 })
  await assert.rejects(login(code()), { status: 401 })
  const signedIn = await login(code(), recovered)
  assert.equal(signedIn.status, 200)
  assert.deepEqual(signedIn.body.user.publicKey, publicKey)
  assert.deepEqual(signedIn.body.user.identity, { ...identity, detached: true })
  assert.deepEqual(revoked, [signedIn.body.user.id])
})

test('a new owner can use profile setup before signing in with an authenticator', async t => {
  const { request, registered, password, login, session, tick } = await fixture(t)
  const originalCookie = registered.cookie
  const { body: status } = await request('GET', 'auth/mfa', undefined, originalCookie)
  assert.deepEqual(status, { enabled: false, required: true, recoveryCodesRemaining: 0 })
  const { body: enrollment } = await request('POST', 'auth/mfa/setup', { current: password }, originalCookie)
  const uri = new URL(enrollment.uri)
  assert.equal(uri.searchParams.get('secret'), enrollment.key)
  const code = () => authenticatorCode(enrollment.key, Date.now() / 1000)
  await assert.rejects(request('POST', 'auth/mfa/confirm', { enrollmentId: enrollment.enrollmentId }, originalCookie),
    { status: 403, code: 'ROOMS_OWNER_CODE' })
  const confirmed = await request('POST', 'auth/mfa/confirm', { enrollmentId: enrollment.enrollmentId, code: code() }, originalCookie)
  assert.equal(confirmed.body.required, true)
  assert.equal(confirmed.body.enabled, true)
  assert.equal(confirmed.body.recoveryCodes.length, 10)
  assert.equal(await session(originalCookie), null)
  assert.equal((await request('POST', 'admin/invites', {}, confirmed.cookie)).status, 201)
  await assert.rejects(request('POST', 'auth/mfa/disable', { current: password }, confirmed.cookie), { status: 403 })

  const recoveryLogin = await login(confirmed.body.recoveryCodes[0])
  assert.ok(await session(recoveryLogin.cookie))
  await assert.rejects(request('POST', 'admin/invites', {}, recoveryLogin.cookie), { status: 403, code: 'ROOMS_OWNER_APPROVAL' })
  tick(60)
  assert.equal((await request('POST', 'admin/authorize', { code: code() }, recoveryLogin.cookie)).status, 200)
})

test('member two-factor sign-in is optional and activation is bound to the enrolling session', async t => {
  const { request, login, tick, provision, session } = await fixture(t)
  const ownerCode = provision()
  const owner = await login(ownerCode())
  const { body: { invite } } = await request('POST', 'admin/invites', {}, owner.cookie)
  const username = 'room-member'
  const password = encoded(32)
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  const member = await request('POST', 'auth/register', { username, displayName: 'Member', password, publicKey,
    identity: newIdentity(), invite: new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite') })
  const signIn = code => request('POST', 'auth/login', { username, password, code })
  await assert.rejects(request('POST', 'auth/mfa/setup', { current: encoded(32) }, member.cookie), { status: 403 })
  const { body: enrollment } = await request('POST', 'auth/mfa/setup', { current: password }, member.cookie)
  const code = () => authenticatorCode(enrollment.key, Date.now() / 1000)
  const confirmation = () => ({ enrollmentId: enrollment.enrollmentId, code: code() })
  const other = await signIn()
  await assert.rejects(request('POST', 'auth/mfa/confirm', confirmation(), other.cookie), { status: 404 })
  assert.equal((await request('GET', 'auth/mfa', undefined, member.cookie)).body.enabled, false)
  const confirmed = await request('POST', 'auth/mfa/confirm', confirmation(), member.cookie)
  assert.deepEqual(await session(confirmed.cookie), member.body.user)
  assert.equal(await session(other.cookie), null)
  assert.equal(await session(member.cookie), null)
  assert.equal(confirmed.body.required, false)
  const [backup, unused] = confirmed.body.recoveryCodes
  await assert.rejects(signIn(), { status: 403, code: 'ROOMS_MFA_CODE' })

  const recovered = await signIn(backup)
  assert.equal((await request('GET', 'auth/mfa', undefined, recovered.cookie)).body.recoveryCodesRemaining, 9)
  await assert.rejects(signIn(backup), { status: 403, code: 'ROOMS_MFA_CODE' })
  const newCredentials = { current: password, password: encoded(32), identity: newIdentity() }
  await assert.rejects(request('POST', 'auth/password', newCredentials, recovered.cookie), { status: 403, code: 'ROOMS_MFA_CODE' })
  tick(60)
  const replaced = await request('POST', 'auth/mfa/recovery-codes', { current: password, code: code() }, recovered.cookie)
  assert.equal(replaced.body.recoveryCodes.length, 10)
  await assert.rejects(signIn(unused), { status: 403, code: 'ROOMS_MFA_CODE' })
  tick(60)
  const disabled = await request('POST', 'auth/mfa/disable', { current: password, code: code() }, replaced.cookie)
  assert.deepEqual(disabled.body, { enabled: false, required: false, recoveryCodesRemaining: 0 })
  assert.equal(await session(replaced.cookie), null)
  assert.equal((await signIn()).status, 200)
})
