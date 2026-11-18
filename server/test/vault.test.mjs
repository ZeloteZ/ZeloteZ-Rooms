import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { createAuth } from '../auth.mjs'
import { json, RequestError } from '../http.mjs'
import { createVault, vaultLimits } from '../vault.mjs'

const origin = 'http://127.0.0.1:8080'
const encoded = n => randomBytes(n).toString('base64url')
function envelope(ids) {
  return { v: 1, nonce: encoded(12), body: encoded(128),
    ephemeral: { kty: 'EC', crv: 'P-256', x: encoded(32), y: encoded(32) },
    keys: Object.fromEntries(ids.map(id => [id, { nonce: encoded(12), blob: encoded(48) }])) }
}
const header = () => ({ v: 1, nonce: encoded(12), body: encoded(100) })
function file(id, size = 100) {
  const chunks = Math.max(1, Math.ceil(size / vaultLimits.chunkBytes))
  return { v: 1, id, contentId: encoded(32), size, chunkSize: vaultLimits.chunkBytes, chunks, cipherSize: size + chunks * 28 }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rooms-vault-test-'))
  const db = new DatabaseSync(join(directory, 'community.sqlite'))
  db.exec('PRAGMA foreign_keys = ON')
  const auth = createAuth(db, { publicOrigin: origin, vaultUsageFor: id => {
    const { enabled, quotaBytes } = vault.config()
    return { enabled, quotaBytes, ...vault.usage(id) }
  } })
  const people = {}
  for (const [name, admin] of [['owner', 1], ['alice', 0], ['bob', 0], ['eve', 0]]) {
    const id = randomUUID(), token = encoded(32)
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(id, name, name.toUpperCase(), '', admin,
      JSON.stringify(publicKey), '{}', new Date().toISOString())
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest(), id, Math.floor(Date.now() / 1000) + 600)
    people[name] = { id, token, publicKey }
  }
  const ownerHash = createHash('sha256').update(people.owner.token).digest()
  db.prepare('INSERT INTO owner_mfa(user_id,secret) VALUES (?,?)').run(people.owner.id, randomBytes(20))
  db.prepare('INSERT INTO owner_approvals VALUES (?,?)').run(ownerHash, Math.floor(Date.now() / 1000) + 600)
  let time = Date.now()
  const vault = createVault(db, { dataDir: directory, requireSession: auth.requireSession, requireAdmin: auth.requireAdmin, clock: () => time })
  await vault.ready
  t.after(async () => { await vault.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  async function request(method, path, body, options = {}) {
    const user = options.user === null ? null : people[options.user ?? 'alice']
    const binary = Buffer.isBuffer(body)
    const stream = options.stream ?? (body === undefined ? [] : [binary ? body : Buffer.from(JSON.stringify(body))])
    const input = Object.assign(Readable.from(stream), { method, url: path,
      headers: { origin, ...(user ? { cookie: 'zelotez_session=' + user.token } : {}),
        ...(body === undefined && !options.stream ? {} : { 'content-type': binary || options.binary ? 'application/octet-stream' : 'application/json' }),
        ...options.headers }, socket: { remoteAddress: '127.0.0.1' } })
    const parts = []
    const response = new Writable({ write(bytes, _encoding, done) { parts.push(Buffer.from(bytes)); if (options.holdWrites) options.holdWrites.push(done); else done() } })
    const headers = {}
    response.setHeader = (name, value) => { headers[name] = value }
    response.writeHead = (status, extra) => { response.statusCode = status; Object.assign(headers, extra); return response }
    try {
      const url = new URL(path, origin)
      const handled = await vault.handlePublic(input, response, url) || await vault.handle(input, response, url)
        || await auth.handle(input, response, url.pathname)
      if (!handled) json(response, 404, { error: 'Nicht gefunden.' })
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      json(response, error.status, { error: error.message, ...(error.code && { code: error.code }) })
    }
    const bytes = Buffer.concat(parts)
    return { status: response.statusCode, headers,
      body: headers['Content-Type']?.startsWith('application/json') ? JSON.parse(bytes) : bytes }
  }
  const enable = (quotaBytes = vaultLimits.defaultQuotaBytes, enabled = true) => request('PATCH', '/api/vault/config', { enabled, quotaBytes }, { user: 'owner' })
  async function entry({ kind = 'file', size = 100, parentId = null, user = 'alice', ...extra } = {}) {
    const id = extra.id ?? randomUUID()
    const body = { id, parentId, kind, envelope: envelope([people[user].id]), descriptor: kind === 'file' ? file(id, size) : null, ...extra }
    return request('POST', '/api/vault/entries', body, { user })
  }
  async function readyFile(options = {}) {
    const created = await entry(options)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const row = created.body.entry
    for (let index = 0; index < row.descriptor.chunks; index++) {
      const size = Math.min(vaultLimits.chunkBytes, Math.max(0, row.descriptor.size - index * vaultLimits.chunkBytes)) + 28
      assert.equal((await request('PUT', `/api/vault/entries/${row.id}/chunks/${index}`, Buffer.alloc(size, 91), { user: options.user ?? 'alice' })).status, 204)
    }
    const completed = await request('POST', `/api/vault/entries/${row.id}/complete`, {}, { user: options.user ?? 'alice' })
    assert.equal(completed.status, 200)
    return completed.body.entry
  }
  return { db, auth, vault, directory, people, request, enable, entry, readyFile,
    tick: amount => { time += amount }, ownerHash }
}

test('only the configured admin receives account storage totals and public account responses omit them', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', '/api/admin/accounts', undefined, { user: null })).status, 401)
  assert.equal((await f.request('GET', '/api/admin/accounts')).status, 403)
  const response = await f.request('GET', '/api/admin/accounts', undefined, { user: 'owner' })
  assert.equal(response.status, 200)
  for (const account of response.body.accounts) {
    assert.deepEqual(account.vault, { enabled: false, quotaBytes: vaultLimits.defaultQuotaBytes, usedBytes: 0, reservedBytes: 0 })
    assert.deepEqual(Object.keys(account).sort(), ['admin', 'disabled', 'displayName', 'id', 'username', 'vault'])
  }
  const session = await f.request('GET', '/api/auth/session')
  assert.equal(session.status, 200); assert.equal(Object.hasOwn(session.body.user, 'vault'), false)
  f.db.prepare('DELETE FROM owner_mfa').run()
  assert.equal((await f.request('GET', '/api/admin/accounts', undefined, { user: 'owner' })).status, 403)
})

test('admin account totals match charged encrypted usage and reservations without exposing file metadata', async t => {
  const f = await fixture(t); await f.enable()
  const ready = await f.readyFile({ size: 107 })
  const pending = await f.entry({ size: 213 })
  assert.equal(pending.status, 201)
  const expected = f.vault.usage(f.people.alice.id)
  assert.ok(expected.usedBytes > 107 && expected.reservedBytes > 213)
  const result = await f.request('GET', '/api/admin/accounts', undefined, { user: 'owner' })
  const account = result.body.accounts.find(value => value.id === f.people.alice.id)
  assert.deepEqual(account.vault, { enabled: true, quotaBytes: vaultLimits.defaultQuotaBytes, ...expected })
  assert.deepEqual(Object.keys(account.vault).sort(), ['enabled', 'quotaBytes', 'reservedBytes', 'usedBytes'])
  const serialized = JSON.stringify(result.body)
  for (const secret of [ready.id, ready.envelope.body, pending.body.entry.id]) assert.equal(serialized.includes(secret), false)
  assert.equal(result.body.accounts.find(value => value.id === f.people.bob.id).vault.usedBytes, 0)
})

test('account mutations retain storage totals for suspended users and disabled Vault preserves over-quota usage', async t => {
  const f = await fixture(t); await f.enable()
  await f.readyFile({ size: vaultLimits.minQuotaBytes + 4096 })
  await f.enable(vaultLimits.minQuotaBytes, false)
  const expected = { enabled: false, quotaBytes: vaultLimits.minQuotaBytes, ...f.vault.usage(f.people.alice.id) }
  assert.ok(expected.usedBytes > expected.quotaBytes)
  const changed = await f.request('PATCH', '/api/admin/accounts/' + f.people.alice.id, { disabled: true }, { user: 'owner' })
  assert.equal(changed.status, 200); assert.equal(changed.body.account.disabled, true)
  assert.deepEqual(changed.body.account.vault, expected)
  const listed = await f.request('GET', '/api/admin/accounts', undefined, { user: 'owner' })
  assert.deepEqual(listed.body.accounts.find(value => value.id === f.people.alice.id).vault, expected)
})

test('Vault defaults off at 2GiB and only a freshly MFA-approved operator can enable or change it', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', '/api/vault/config')).body.enabled, false)
  assert.equal(f.vault.config().quotaBytes, 2 * 1024 ** 3)
  assert.equal((await f.request('GET', '/api/vault')).status, 404)
  assert.equal((await f.entry()).status, 404)
  assert.equal((await f.request('GET', '/api/vault/config', undefined, { user: null })).status, 401)
  assert.equal((await f.request('PATCH', '/api/vault/config', { enabled: true, quotaBytes: 1024 ** 2 })).status, 403)
  f.db.prepare('DELETE FROM owner_approvals').run()
  const unapproved = await f.enable()
  assert.equal(unapproved.status, 403)
  assert.equal(unapproved.body.code, 'ROOMS_OWNER_APPROVAL')
  f.db.prepare('INSERT INTO owner_approvals VALUES (?,?)').run(f.ownerHash, Math.floor(Date.now() / 1000) + 600)
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER, 1024 ** 4 + 1]) {
    assert.equal((await f.enable(value)).status, 400)
  }
  assert.equal((await f.enable(1024 ** 2)).status, 200)
  assert.equal(f.vault.config().enabled, true)
})

test('strict descriptors, self-only encrypted headers and same-owner folders prevent quota or hierarchy tampering', async t => {
  const f = await fixture(t); await f.enable()
  const other = (await f.entry({ kind: 'folder', user: 'bob' })).body.entry
  assert.equal((await f.entry({ parentId: other.id })).status, 404)
  assert.equal((await f.entry({ envelope: envelope([f.people.alice.id, f.people.bob.id]) })).status, 409)
  assert.equal((await f.entry({ kind: 'folder', descriptor: {} })).status, 400)
  assert.equal((await f.entry({ filename: 'secret-filename.txt' })).status, 400)
  for (const change of [{ size: -1 }, { size: 1.5 }, { chunks: 0 }, { chunkSize: 1024 }, { cipherSize: 3 }, { id: randomUUID() }, { contentId: '../escape' }]) {
    const id = randomUUID()
    assert.equal((await f.entry({ id, descriptor: { ...file(id), ...change } })).status, 400)
  }
  const a = (await f.entry({ kind: 'folder' })).body.entry
  const b = (await f.entry({ kind: 'folder', parentId: a.id })).body.entry
  assert.equal((await f.request('PATCH', '/api/vault/entries/' + a.id, { parentId: b.id })).status, 400)
  assert.equal((await f.request('PATCH', '/api/vault/entries/' + b.id, { parentId: b.id })).status, 400)
  assert.equal((await f.request('PATCH', '/api/vault/entries/' + a.id, { descriptor: null })).status, 400)
})

test('reservations atomically enforce encrypted storage quota across competing uploads and account for metadata', async t => {
  const f = await fixture(t); await f.enable(1024 ** 2)
  const outcomes = await Promise.all([f.entry({ size: 700000 }), f.entry({ size: 700000 })])
  assert.deepEqual(outcomes.map(x => x.status).sort(), [201, 413])
  const staged = outcomes.find(x => x.status === 201).body.entry
  const first = (await f.request('GET', '/api/vault')).body
  assert(first.reservedBytes > staged.descriptor.cipherSize)
  assert.equal(first.usedBytes, vaultLimits.idBytes)
  assert.equal((await f.request('POST', `/api/vault/entries/${staged.id}/complete`, {})).status, 409)
  assert.equal((await f.request('DELETE', '/api/vault/entries/' + staged.id)).status, 204)
  assert.equal(f.vault.usage(f.people.alice.id).reservedBytes, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault')), [])
  for (let i = 0; i < 4; i++) assert.equal((await f.entry()).status, 201)
  assert.equal((await f.entry()).status, 429)
})

test('chunk uploads are bounded, immutable and idempotent; completion requires the exact full ciphertext', async t => {
  const f = await fixture(t); await f.enable()
  const row = (await f.entry()).body.entry
  const path = `/api/vault/entries/${row.id}/chunks/0`
  assert.equal((await f.request('PUT', path, Buffer.alloc(127))).status, 400)
  assert.equal((await f.request('PUT', path, Buffer.alloc(129))).status, 413)
  assert.equal((await f.request('PUT', path, Buffer.alloc(128, 5))).status, 204)
  assert.equal((await f.request('PUT', path, Buffer.alloc(128, 5))).status, 204)
  assert.equal((await f.request('PUT', path, Buffer.alloc(128, 6))).status, 409)
  assert.deepEqual((await f.request('GET', '/api/vault/entries/' + row.id)).body.entry.uploadedChunks, [0])
  assert.equal((await f.request('GET', path)).status, 404)
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/complete`, {})).status, 200)
  const read = await f.request('GET', path)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body, Buffer.alloc(128, 5))
  assert.equal(read.headers['Cache-Control'], 'private, no-store')
  assert.equal(read.headers['Content-Type'], 'application/octet-stream')
  assert.equal((await f.request('PUT', path, Buffer.alloc(128, 5))).status, 400)
  const zero = await f.readyFile({ size: 0 })
  assert.equal(zero.descriptor.chunks, 1)
  assert.equal((await f.request('GET', `/api/vault/entries/${zero.id}/chunks/0`)).body.length, 28)
  const multi = await f.readyFile({ size: vaultLimits.chunkBytes + 17 })
  assert.equal((await f.request('GET', `/api/vault/entries/${multi.id}/chunks/1`)).body.length, 45)
})

test('other accounts cannot list, read, rename, move, upload to or delete private entries', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  assert.equal((await f.request('GET', '/api/vault', undefined, { user: 'bob' })).body.entries.length, 0)
  for (const [method, suffix, body] of [['GET', '', undefined], ['PATCH', '', { parentId: null }], ['DELETE', '', undefined],
    ['GET', '/chunks/0', undefined], ['PUT', '/chunks/0', Buffer.alloc(128)], ['POST', '/complete', {}], ['GET', '/shares', undefined]]) {
    assert.equal((await f.request(method, '/api/vault/entries/' + row.id + suffix, body, { user: 'bob' })).status, 404)
  }
  assert.equal((await f.request('GET', '/api/vault/entries/../../community.sqlite')).status, 404)
})

test('member sharing discloses only ciphertext to the intended account and revocation, expiry or suspension blocks each chunk', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const id = randomUUID()
  const created = await f.request('POST', `/api/vault/entries/${row.id}/shares`, {
    id, recipientId: f.people.bob.id, envelope: envelope([f.people.alice.id, f.people.bob.id]), expiresAt: Date.now() + 60000 })
  assert.equal(created.status, 201)
  const received = (await f.request('GET', '/api/vault', undefined, { user: 'bob' })).body.receivedShares
  assert.equal(received.length, 1)
  assert.equal(received[0].owner.id, f.people.alice.id)
  assert.deepEqual(received[0].descriptor, row.descriptor)
  const path = `/api/vault/received/${id}/chunks/0`
  assert.equal((await f.request('GET', path, undefined, { user: 'bob' })).status, 200)
  assert.equal((await f.request('GET', path, undefined, { user: 'eve' })).status, 404)
  assert.equal((await f.request('DELETE', '/api/vault/shares/' + id, undefined, { user: 'bob' })).status, 404)
  f.db.prepare('INSERT INTO disabled_accounts VALUES (?,?)').run(f.people.alice.id, Math.floor(Date.now() / 1000))
  assert.equal((await f.request('GET', path, undefined, { user: 'bob' })).status, 404)
  f.db.prepare('DELETE FROM disabled_accounts WHERE user_id = ?').run(f.people.alice.id)
  assert.equal((await f.request('DELETE', '/api/vault/shares/' + id)).status, 204)
  assert.equal((await f.request('GET', path, undefined, { user: 'bob' })).status, 404)
})

test('public links use only hashed bearer capabilities, never URL keys; file deletion and switch-off revoke access', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const token = encoded(32), tokenHash = createHash('sha256').update(token).digest('base64url'), id = randomUUID()
  const body = { id, tokenHash, envelope: header(), ownerEnvelope: envelope([f.people.alice.id]), expiresAt: Date.now() + 60000 }
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/shares`, body)).status, 201)
  const stored = f.db.prepare('SELECT * FROM vault_shares WHERE id = ?').get(id)
  assert(!JSON.stringify(stored).includes(token))
  assert.deepEqual(Buffer.from(stored.token_hash), createHash('sha256').update(token).digest())
  const opened = await f.request('POST', '/api/vault/public/open', { id, token }, { user: null })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.share.ownerEnvelope, undefined)
  assert.equal(opened.body.share.envelope.keys, undefined)
  const path = `/api/vault/public/${id}/chunks/0`
  const headers = { authorization: 'Bearer ' + token }
  assert.equal((await f.request('GET', path, undefined, { user: null, headers })).status, 200)
  assert.equal((await f.request('GET', path, undefined, { user: null })).status, 404)
  assert.equal((await f.request('GET', path + '?token=' + token, undefined, { user: null })).status, 404)
  assert.equal((await f.request('POST', '/api/vault/public/open', { id, token: encoded(32) }, { user: null })).status, 404)
  assert.equal((await f.request('POST', '/api/vault/public/open', { id, token, key: 'never-accepted' }, { user: null })).status, 400)
  await f.enable(vaultLimits.defaultQuotaBytes, false)
  assert.equal((await f.request('POST', '/api/vault/public/open', { id, token }, { user: null })).status, 404)
  await f.enable()
  assert.equal((await f.request('GET', path, undefined, { user: null, headers })).status, 200)
  assert.equal((await f.request('DELETE', '/api/vault/entries/' + row.id)).status, 204)
  assert.equal((await f.request('GET', path, undefined, { user: null, headers })).status, 404)
})

test('watch sources accept only active own public shares and recheck feature, expiry, suspension and file state', async t => {
  const f = await fixture(t)
  assert.equal(f.vault.watchShare(f.people.alice.id, randomUUID()), false)
  await f.enable()
  const row = await f.readyFile()
  const id = randomUUID(), expiresAt = Date.now() + 10000
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/shares`, { id, tokenHash: encoded(32), envelope: header(), expiresAt })).status, 201)
  assert.equal(f.vault.watchShare(f.people.alice.id, id), true)
  assert.equal(f.vault.watchShare(f.people.bob.id, id), false)
  assert.equal(f.vault.watchShare(f.people.alice.id, '../community.sqlite'), false)
  const memberId = randomUUID()
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/shares`, { id: memberId, recipientId: f.people.bob.id,
    envelope: envelope([f.people.alice.id, f.people.bob.id]), expiresAt })).status, 201)
  assert.equal(f.vault.watchShare(f.people.alice.id, memberId), false)
  f.db.prepare('INSERT INTO disabled_accounts VALUES (?,?)').run(f.people.alice.id, Math.floor(Date.now() / 1000))
  assert.equal(f.vault.watchShare(f.people.alice.id, id), false)
  f.db.prepare('DELETE FROM disabled_accounts WHERE user_id = ?').run(f.people.alice.id)
  await f.enable(vaultLimits.defaultQuotaBytes, false)
  assert.equal(f.vault.watchShare(f.people.alice.id, id), false)
  await f.enable()
  assert.equal(f.vault.watchShare(f.people.alice.id, id), true)
  f.db.prepare("UPDATE vault_entries SET state = 'uploading' WHERE id = ?").run(row.id)
  assert.equal(f.vault.watchShare(f.people.alice.id, id), false)
  f.db.prepare("UPDATE vault_entries SET state = 'ready' WHERE id = ?").run(row.id)
  f.tick(11000)
  assert.equal(f.vault.watchShare(f.people.alice.id, id), false)
})

test('expiry is checked without relying on housekeeping and disabling aborts reservations but retains committed data', async t => {
  const f = await fixture(t); await f.enable()
  const ready = await f.readyFile()
  const staged = (await f.entry()).body.entry
  const id = randomUUID(), token = encoded(32)
  await f.request('POST', `/api/vault/entries/${ready.id}/shares`, { id,
    tokenHash: createHash('sha256').update(token).digest('base64url'), envelope: header(), expiresAt: Date.now() + 2000 })
  f.tick(5000)
  assert.equal((await f.request('POST', '/api/vault/public/open', { id, token }, { user: null })).status, 404)
  await f.enable(vaultLimits.defaultQuotaBytes, false)
  assert.equal(f.db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(staged.id), undefined)
  assert(f.db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(ready.id))
  assert.equal(f.vault.usage(f.people.alice.id).reservedBytes, 0)
  await f.enable()
  assert.equal((await f.request('GET', `/api/vault/entries/${ready.id}/chunks/0`)).status, 200)
})

test('recursive folder deletion removes ciphertext, shares and quota without touching another user', async t => {
  const f = await fixture(t); await f.enable()
  const folder = (await f.entry({ kind: 'folder' })).body.entry
  const child = (await f.entry({ kind: 'folder', parentId: folder.id })).body.entry
  const row = await f.readyFile({ parentId: child.id })
  const other = await f.readyFile({ user: 'bob' })
  await f.request('POST', `/api/vault/entries/${row.id}/shares`, { id: randomUUID(), recipientId: f.people.bob.id,
    envelope: envelope([f.people.alice.id, f.people.bob.id]), expiresAt: Date.now() + 60000 })
  assert.equal((await f.request('DELETE', '/api/vault/entries/' + folder.id)).status, 204)
  assert.equal(f.vault.usage(f.people.alice.id).usedBytes, 4 * vaultLimits.idBytes)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_shares').get().n, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault')), [other.id])
})

test('stale and interrupted uploads cannot leave permanent quota or untracked ciphertext behind', async t => {
  const f = await fixture(t); await f.enable()
  const row = (await f.entry()).body.entry
  const bytes = Buffer.alloc(128)
  const broken = (async function* () { yield bytes.subarray(0, 50); throw new Error('Interrupted upload') })()
  await assert.rejects(f.request('PUT', `/api/vault/entries/${row.id}/chunks/0`, undefined, { stream: broken, binary: true }), /Interrupted upload/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_chunks').get().n, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault', row.id)), [])
  const orphan = randomUUID()
  await mkdir(join(f.directory, 'vault', orphan))
  await writeFile(join(f.directory, 'vault', orphan, '0'), Buffer.alloc(100))
  await writeFile(join(f.directory, 'vault', row.id, '.interrupted'), Buffer.alloc(50))
  await f.vault.cleanup()
  assert.deepEqual(await readdir(join(f.directory, 'vault')), [row.id])
  assert.deepEqual(await readdir(join(f.directory, 'vault', row.id)), [])
  f.tick(vaultLimits.uploadLifetime + 1)
  await f.vault.cleanup()
  assert.equal(f.vault.usage(f.people.alice.id).reservedBytes, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault')), [])
})

test('logout during the request body prevents a chunk from becoming readable or committed', async t => {
  const f = await fixture(t); await f.enable()
  const row = (await f.entry()).body.entry
  const stream = (async function* () {
    yield Buffer.alloc(128)
    f.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(f.people.alice.id)
  })()
  const result = await f.request('PUT', `/api/vault/entries/${row.id}/chunks/0`, undefined, { stream, binary: true })
  assert.equal(result.status, 401)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_chunks').get().n, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault', row.id)), [])
})

test('chunk integrity is checked before returning bytes and recipient searches exclude suspended accounts', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const path = join(f.directory, 'vault', row.id, '0')
  const encrypted = await readFile(path); encrypted[20] ^= 1; await writeFile(path, encrypted)
  assert.equal((await f.request('GET', `/api/vault/entries/${row.id}/chunks/0`)).status, 404)
  f.db.prepare('INSERT INTO disabled_accounts VALUES (?,?)').run(f.people.bob.id, Math.floor(Date.now() / 1000))
  assert.deepEqual((await f.request('GET', '/api/vault/recipients?query=bob')).body.recipients, [])
  const recipients = (await f.request('GET', '/api/vault/recipients?query=eve')).body.recipients
  assert.equal(recipients.length, 1)
  assert.deepEqual(recipients[0].publicKey, f.people.eve.publicKey)
  assert.equal((await f.request('GET', '/api/vault/recipients?query=%25')).body.recipients.length, 0)
})

test('deleted entries and expired or revoked public capabilities cannot be resurrected under another account', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const id = randomUUID(), token = encoded(32), tokenHash = createHash('sha256').update(token).digest('base64url')
  const first = { id, tokenHash, envelope: header(), expiresAt: Date.now() + 10000 }
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/shares`, first)).status, 201)
  assert.equal((await f.request('DELETE', '/api/vault/entries/' + row.id)).status, 204)
  assert.equal((await f.entry({ user: 'bob', id: row.id })).status, 409)
  const replacement = await f.readyFile({ user: 'bob' })
  assert.equal((await f.request('POST', `/api/vault/entries/${replacement.id}/shares`, first, { user: 'bob' })).status, 409)
  const stored = f.db.prepare('SELECT * FROM vault_used_ids').all()
  assert(stored.every(record => Object.keys(record).join() === 'digest'))
  assert(stored.every(record => record.digest.length === 32))
  assert.equal(f.vault.usage(f.people.alice.id).usedBytes, 2 * vaultLimits.idBytes)
  assert.equal((await f.request('POST', '/api/vault/public/open', { id, token }, { user: null })).status, 404)
})

test('metadata mutation limits bound persistent identity bookkeeping while still permitting abort and later retry', async t => {
  const f = await fixture(t); await f.enable()
  const row = (await f.entry()).body.entry
  for (let i = 0; i < 599; i++) assert.equal((await f.request('POST', '/api/vault/entries', {})).status, 400)
  assert.equal((await f.entry()).status, 429)
  assert.equal((await f.request('DELETE', '/api/vault/entries/' + row.id)).status, 204)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_used_ids').get().n, 1)
  f.tick(60001)
  assert.equal((await f.entry()).status, 201)
})

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected test stream did not become ready')
}

test('chunk and large-list concurrency reservations remain held until the response drains', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const firstWrites = [], secondWrites = []
  const first = f.request('GET', `/api/vault/entries/${row.id}/chunks/0`, undefined, { holdWrites: firstWrites })
  await until(() => firstWrites.length)
  const second = f.request('GET', `/api/vault/entries/${row.id}/chunks/0`, undefined, { holdWrites: secondWrites })
  await until(() => secondWrites.length)
  assert.equal((await f.request('GET', `/api/vault/entries/${row.id}/chunks/0`)).status, 429)
  for (const finish of [...firstWrites, ...secondWrites]) finish()
  assert.equal((await first).status, 200); assert.equal((await second).status, 200)
  const listWrites = [], otherWrites = []
  const list = f.request('GET', '/api/vault', undefined, { holdWrites: listWrites })
  await until(() => listWrites.length)
  assert.equal((await f.request('GET', '/api/vault')).status, 429)
  const other = f.request('GET', '/api/vault', undefined, { user: 'bob', holdWrites: otherWrites })
  await until(() => otherWrites.length)
  assert.equal((await f.request('GET', '/api/vault', undefined, { user: 'eve' })).status, 429)
  for (const finish of [...listWrites, ...otherWrites]) finish()
  assert.equal((await list).status, 200); assert.equal((await other).status, 200)
})

test('housekeeping never deletes chunks from live uploads and per-user upload backpressure is bounded', async t => {
  const f = await fixture(t); await f.enable()
  const rows = [(await f.entry()).body.entry, (await f.entry()).body.entry, (await f.entry()).body.entry]
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started = 0
  function stream() { return (async function* () { yield Buffer.alloc(60); started++; await gate; yield Buffer.alloc(68) })() }
  const pending = rows.slice(0, 2).map(row => f.request('PUT', `/api/vault/entries/${row.id}/chunks/0`, undefined, { stream: stream(), binary: true }))
  await until(() => started === 2)
  assert.equal((await f.request('PUT', `/api/vault/entries/${rows[2].id}/chunks/0`, Buffer.alloc(128))).status, 429)
  f.tick(vaultLimits.uploadLifetime + 1)
  await f.vault.cleanup()
  assert(f.db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(rows[0].id))
  assert.equal(f.db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(rows[2].id), undefined)
  release()
  assert.deepEqual((await Promise.all(pending)).map(result => result.status), [204, 204])
})

test('moving a folder cannot smuggle a deep subtree beyond the depth limit', async t => {
  const f = await fixture(t); await f.enable()
  let first = null, second = null, firstRoot
  for (let depth = 0; depth < 20; depth++) {
    const a = (await f.entry({ kind: 'folder', parentId: first })).body.entry
    const b = (await f.entry({ kind: 'folder', parentId: second })).body.entry
    firstRoot ??= a.id; first = a.id; second = b.id
  }
  assert.equal((await f.request('PATCH', '/api/vault/entries/' + firstRoot, { parentId: second })).status, 400)
})

test('database-full failures roll back reservations and bookkeeping and return an actionable status', async t => {
  const f = await fixture(t); await f.enable()
  f.db.exec('CREATE TABLE pressure (value BLOB);')
  const pages = f.db.prepare('PRAGMA page_count').get().page_count
  f.db.exec('PRAGMA max_page_count = ' + (pages + 8))
  try { while (true) f.db.prepare('INSERT INTO pressure VALUES (zeroblob(1000))').run() } catch (error) { assert.equal(error.errcode & 255, 13) }
  let observed = false
  for (let attempt = 0; attempt < 300; attempt++) {
    const id = randomUUID(), before = f.vault.usage(f.people.alice.id)
    const result = await f.entry({ id })
    if (result.status === 507) {
      observed = true
      assert.equal(f.db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(id), undefined)
      assert.equal(f.db.prepare('SELECT 1 FROM vault_used_ids WHERE digest = ?').get(createHash('sha256').update(id).digest()), undefined)
      assert.deepEqual(f.vault.usage(f.people.alice.id), before)
      break
    }
    assert.equal(result.status, 201)
    await f.request('DELETE', '/api/vault/entries/' + id)
  }
  assert(observed, 'A constrained SQLite database must reject a reservation without leaking quota')
})

test('restart preserves committed chunks, settings and irreversible ID accounting without double charging', async t => {
  const f = await fixture(t); await f.enable()
  const row = await f.readyFile()
  const before = f.vault.usage(f.people.alice.id)
  await f.vault.close()
  const reopened = createVault(f.db, { dataDir: f.directory, requireSession: f.auth.requireSession, requireAdmin: f.auth.requireAdmin })
  try {
    await reopened.ready
    assert.equal(reopened.config().enabled, true)
    assert.deepEqual(reopened.usage(f.people.alice.id), before)
    assert.equal((await readFile(join(f.directory, 'vault', row.id, '0'))).length, row.descriptor.cipherSize)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_used_ids').get().n, 1)
  } finally { await reopened.close() }
})

test('a database-full chunk commit removes the fsynced orphan and allows retry without a second reservation', async t => {
  const f = await fixture(t); await f.enable()
  const row = (await f.entry()).body.entry
  const before = f.vault.usage(f.people.alice.id)
  const original = f.db.prepare.bind(f.db)
  const failure = t.mock.method(f.db, 'prepare', function (sql, ...args) {
    if (sql === 'INSERT INTO vault_chunks VALUES (?,?,?,?)') return {
      run() { throw Object.assign(new Error('Injected SQLite full at chunk commit'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }) },
    }
    return original(sql, ...args)
  })
  const path = `/api/vault/entries/${row.id}/chunks/0`
  assert.equal((await f.request('PUT', path, Buffer.alloc(128))).status, 507)
  failure.mock.restore()
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_chunks').get().n, 0)
  assert.deepEqual(await readdir(join(f.directory, 'vault', row.id)), [])
  assert.deepEqual(f.vault.usage(f.people.alice.id), before)
  assert.equal((await f.request('PUT', path, Buffer.alloc(128))).status, 204)
  assert.equal((await f.request('POST', `/api/vault/entries/${row.id}/complete`, {})).status, 200)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vault_used_ids').get().n, 1)
})
