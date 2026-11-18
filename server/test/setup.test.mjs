import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { bootstrapOwnerInvite, createAuth, initializeAuthSchema } from '../auth.mjs'
import { configuredSetupKey, createSetup, ensureSetupKey, setupPending } from '../setup.mjs'

const origin = 'https://rooms.example.com'
const token = () => randomBytes(32).toString('base64url')
const folder = t => {
  const path = mkdtempSync(join(tmpdir(), 'rooms-setup-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function fixture(t, { path = ':memory:', key = token() } = {}) {
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('PRAGMA foreign_keys = ON')
  let closed = false
  const close = () => { if (!closed) { db.close(); closed = true } }
  t.after(close)
  const auth = createAuth(db, { publicOrigin: origin })
  const setup = createSetup(db, { publicOrigin: origin, setupKey: key,
    bootstrap: () => bootstrapOwnerInvite(db, origin, { browserSetup: true }) })
  async function request(method, url, body, { cookie, requestOrigin = origin, contentType = 'application/json', address = '127.0.0.1' } = {}) {
    const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Readable.from(bytes)
    req.method = method
    req.url = url
    req.socket = { remoteAddress: address }
    req.headers = { origin: requestOrigin, cookie, ...(body !== undefined && { 'content-type': contentType }) }
    const chunks = [], headers = {}
    let status
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
    res.setHeader = (name, value) => { headers[name] = value }
    res.writeHead = (code, more) => { status = code; Object.assign(headers, more); return res }
    const pathname = new URL(url, origin).pathname
    assert.equal(await (pathname === '/api/setup' ? setup : auth).handle(req, res, pathname), true)
    return { status, headers, cookie: headers['Set-Cookie']?.split(';', 1)[0], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined }
  }
  return { db, auth, request, key, close }
}
const ownerBody = invite => ({ username: 'first-owner', displayName: 'Owner', password: token(), invite,
  publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }),
  identity: { v: 1, nonce: randomBytes(12).toString('base64url'), blob: randomBytes(64).toString('base64url') } })
const insertLegacyOwner = db => db.prepare("INSERT INTO users VALUES ('legacy-owner', 'legacy-owner', 'Owner', '', 1, '{}', '{}', '2026-01-01T00:00:00Z')").run()

test('first-run endpoint is opt-in, same-origin, small, and discloses no setup key', async t => {
  const disabled = fixture(t, { key: null })
  assert.deepEqual((await disabled.request('GET', '/api/setup')).body, { available: false })
  await assert.rejects(disabled.request('POST', '/api/setup', { key: token() }), { status: 409 })
  const { request, key, db } = fixture(t)
  const status = await request('GET', '/api/setup')
  assert.deepEqual(status.body, { available: true })
  assert.equal(status.headers['Cache-Control'], 'private, no-store')
  assert(!JSON.stringify(status).includes(key))
  assert(!status.headers['Set-Cookie'])
  await assert.rejects(request('POST', '/api/setup', { key }, { requestOrigin: 'https://elsewhere.example' }), { status: 403 })
  await assert.rejects(request('POST', '/api/setup', { key: token() }), { status: 403 })
  await assert.rejects(request('POST', '/api/setup', { key, username: 'owner' }), { status: 403 })
  await assert.rejects(request('POST', '/api/setup', { key: 'x'.repeat(300) }), { status: 413 })
  await assert.rejects(request('POST', '/api/setup', { key }, { contentType: 'text/plain' }), { status: 415 })
  await assert.rejects(request('GET', '/api/setup?key=ignored'), { status: 400 })
  assert.equal((await request('PUT', '/api/setup', {})).status, 405)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0)
})

test('same setup key recovers a closed tab, invalidates old invites, and cannot create parallel owners', async t => {
  const directory = folder(t), path = join(directory, 'community.sqlite')
  const { db, request, key, close } = fixture(t, { path })
  const first = (await request('POST', '/api/setup', { key })).body.invite
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  const firstBody = ownerBody(first)
  const inFlight = request('POST', '/api/auth/register', firstBody)
  // Let normal password derivation start before the operator retries setup in another tab.
  await new Promise(resolve => setImmediate(resolve))
  const second = (await request('POST', '/api/setup', { key })).body.invite
  assert.notEqual(first, second)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL').get().n, 1)
  const secondBody = { ...firstBody, username: 'current-owner', invite: second }
  const results = await Promise.allSettled([inFlight, request('POST', '/api/auth/register', secondBody, { address: '127.0.0.2' })])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[0].reason.status, 400)
  assert.equal(results[1].status, 'fulfilled', String(results[1].reason))
  const registered = results[1].value
  assert.equal(registered.status, 201)
  assert.equal(registered.body.user.admin, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE admin = 1').get().n, 1)
  assert.deepEqual((await request('GET', '/api/setup')).body, { available: false })
  await assert.rejects(request('POST', '/api/setup', { key }), { status: 409 })
  assert.equal(ensureSetupKey(db, { APP_DATA_DIR: directory }), null)
  // The existing owner protections still require TOTP before sign-in and administrative access.
  await assert.rejects(request('POST', '/api/auth/login', { username: secondBody.username, password: secondBody.password }), { status: 403 })
  await assert.rejects(request('GET', '/api/admin/accounts', undefined, { cookie: registered.cookie }), { status: 403 })
  const enrollment = await request('POST', '/api/auth/mfa/setup', { current: secondBody.password }, { cookie: registered.cookie })
  assert.equal(enrollment.status, 200)
  assert.match(enrollment.body.key, /^[A-Z2-7]+$/)
  // Even explicit local account cleanup followed by a restart cannot reopen a completed wizard.
  db.exec('DELETE FROM users; DELETE FROM invites')
  close()
  const reopened = fixture(t, { path, key })
  assert.deepEqual((await reopened.request('GET', '/api/setup')).body, { available: false })
  await assert.rejects(reopened.request('POST', '/api/setup', { key }), { status: 409 })
})

test('legacy installations and local bootstrap invitations never expose the browser wizard', async t => {
  const { db, request, key } = fixture(t)
  bootstrapOwnerInvite(db, origin)
  assert.deepEqual((await request('GET', '/api/setup')).body, { available: false })
  await assert.rejects(request('POST', '/api/setup', { key }), { status: 409 })
  // Simulate an upgrade from a database written before the setup-state migration existed.
  db.exec('DROP TABLE first_run_setup')
  initializeAuthSchema(db)
  assert.equal(setupPending(db), false)
  const emptyLegacy = fixture(t)
  emptyLegacy.db.exec('DROP TABLE first_run_setup')
  initializeAuthSchema(emptyLegacy.db)
  assert.equal(setupPending(emptyLegacy.db), false)
  const oldAccount = fixture(t)
  oldAccount.db.exec('DROP TABLE first_run_setup')
  insertLegacyOwner(oldAccount.db)
  initializeAuthSchema(oldAccount.db)
  assert.equal(setupPending(oldAccount.db), false)
  assert.deepEqual((await oldAccount.request('GET', '/api/setup')).body, { available: false })
})

test('unfinished browser setup survives a restart and rotates its sole invitation on retry', async t => {
  const path = join(folder(t), 'community.sqlite'), key = token()
  const first = fixture(t, { path, key })
  const old = (await first.request('POST', '/api/setup', { key })).body.invite
  first.close()
  const second = fixture(t, { path, key })
  assert.deepEqual((await second.request('GET', '/api/setup')).body, { available: true })
  const current = (await second.request('POST', '/api/setup', { key })).body.invite
  assert.notEqual(current, old)
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL').get().n, 1)
})

test('setup attempts are bounded per client without a global lockout', async t => {
  const { request, key } = fixture(t)
  for (let i = 0; i < 12; i++) await assert.rejects(request('POST', '/api/setup', { key: token() }), { status: 403 })
  const limited = await request('POST', '/api/setup', { key })
  assert.equal(limited.status, 429)
  assert(Number(limited.headers['Retry-After']) > 0)
  assert.equal((await request('POST', '/api/setup', { key }, { address: '127.0.0.2' })).status, 201)
})

test('local setup key is stable, private, and safely disabled after setup', t => {
  const directory = folder(t), path = join(directory, '.rooms-setup-token')
  const { db } = fixture(t)
  const env = { APP_DATA_DIR: directory, ROOMS_SETUP_TOKEN_FILE: path }
  const first = ensureSetupKey(db, env)
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(ensureSetupKey(db, env), first)
  assert.equal(configuredSetupKey(db, env), first)
  assert.equal(configuredSetupKey(db, { APP_DATA_DIR: directory }), null)
  const override = token()
  assert.equal(configuredSetupKey(db, { ...env, ROOMS_SETUP_TOKEN: override }), override)
  chmodSync(path, 0o644)
  assert.throws(() => configuredSetupKey(db, env), /0600/)
  chmodSync(path, 0o600)
  const alias = join(directory, 'alias')
  symlinkSync(path, alias)
  assert.throws(() => configuredSetupKey(db, { ROOMS_SETUP_TOKEN_FILE: alias }))
  assert.throws(() => configuredSetupKey(db, { ROOMS_SETUP_TOKEN: 'not-random' }))
  insertLegacyOwner(db)
  assert.equal(ensureSetupKey(db, env), null)
  assert.equal(configuredSetupKey(db, { ROOMS_SETUP_TOKEN_FILE: join(directory, 'missing') }), null)
})

test('entrypoint CLI ensures silently and operator CLI prints only the stable pending key', t => {
  const directory = folder(t), path = join(directory, '.rooms-setup-token')
  const env = { ...process.env, APP_DATA_DIR: directory, PUBLIC_ORIGIN: origin, ROOMS_SETUP_TOKEN_FILE: path }
  delete env.ROOMS_SETUP_TOKEN
  const run = option => spawnSync(process.execPath, [fileURLToPath(new URL('../bootstrap.mjs', import.meta.url)), option], { env, encoding: 'utf8', timeout: 10000 })
  const ensured = run('--ensure-setup-key')
  assert.equal(ensured.status, 0, ensured.stderr)
  assert.equal(ensured.stdout, '')
  const key = readFileSync(path, 'utf8').trim()
  const printed = run('--setup-key')
  assert.equal(printed.status, 0, printed.stderr)
  assert.equal(printed.stdout, key + '\n')
  const db = new DatabaseSync(join(directory, 'community.sqlite'))
  insertLegacyOwner(db)
  db.close()
  const sealed = run('--ensure-setup-key')
  assert.equal(sealed.status, 0, sealed.stderr)
  assert.equal(sealed.stdout, '')
  const refused = run('--setup-key')
  assert.equal(refused.status, 1)
  assert.equal(refused.stdout, '')
  assert(!refused.stderr.includes(key))
  const legacy = run('--if-needed')
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.equal(legacy.stdout, '')
})

test('simultaneous initial entrypoints preserve one private key and a usable pending setup', async t => {
  const directory = folder(t), path = join(directory, '.rooms-setup-token')
  const env = { ...process.env, APP_DATA_DIR: directory, PUBLIC_ORIGIN: origin, ROOMS_SETUP_TOKEN_FILE: path }
  delete env.ROOMS_SETUP_TOKEN
  const args = [fileURLToPath(new URL('../bootstrap.mjs', import.meta.url)), '--ensure-setup-key']
  const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, args, { env, timeout: 10000 })))
  for (const result of results) assert.equal(result.stdout, '')
  const key = readFileSync(path, 'utf8').trim()
  assert.match(key, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const reopened = fixture(t, { path: join(directory, 'community.sqlite'), key })
  assert.equal(configuredSetupKey(reopened.db, env), key)
  assert.deepEqual((await reopened.request('GET', '/api/setup')).body, { available: true })
})
