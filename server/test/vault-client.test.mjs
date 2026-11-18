import assert from 'node:assert/strict'
import { randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// Browser UI is not instantiated by these transfer/security tests.
globalThis.document = { querySelector() { return null }, documentElement: { lang: 'en' } }
globalThis.location = new URL('https://rooms.example.test/#/vault')
globalThis.localStorage = { getItem() { return null } }
const client = await import('../../web/vault-client.js')
const vault = await import('../../web/vault-crypto.js')
const helpers = await import('../../web/vault.js')
const accountScript = readFileSync(new URL('../../web/crypto.js', import.meta.url), 'utf8')
const encode = value => new TextEncoder().encode(value)

function storage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}
async function fixture(t, data = encode('Private file contents')) {
  vault.clearVaultKeys()
  const window = {}
  runInNewContext(accountScript, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } })
  const prepared = await window.ClubCrypto.prepareRegistration('vault-client', 'A long vault client test passphrase')
  const user = { id: randomUUID(), username: 'vault-client', publicKey: prepared.publicKey, identity: prepared.identity }
  await window.ClubCrypto.unlock(user, 'A long vault client test passphrase')
  globalThis.ClubCrypto = window.ClubCrypto
  const priorFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = priorFetch; vault.clearVaultKeys(); delete globalThis.ClubCrypto })
  const file = new File([data], 'private-plan-计划.txt', { type: 'text/plain', lastModified: 1700000000000 })
  const created = await vault.createFile(user, randomUUID(), file)
  const entry = { id: created.descriptor.id, ownerId: user.id, parentId: null, kind: 'file', state: 'ready',
    descriptor: created.descriptor, envelope: created.envelope }
  return { user, file, created, entry, data }
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

test('public share capabilities and keys stay in the fragment and are consumed before requests', () => {
  const id = randomUUID(), token = Buffer.alloc(32, 5).toString('base64url'), keyFragment = Buffer.alloc(32, 6).toString('base64url')
  const url = client.publicVaultLink(id, token, keyFragment)
  const parsed = new URL(url)
  assert.equal(parsed.pathname, '/vault')
  assert.equal(parsed.search, '')
  assert.ok(!url.split('#')[0].includes(token))
  assert.ok(!url.split('#')[0].includes(keyFragment))
  let cleared = false
  assert.deepEqual(client.takePublicVaultLink(url, () => { cleared = true }), { id, token, keyFragment })
  assert.equal(cleared, true)
  assert.equal(client.takePublicVaultLink('https://rooms.example.test/vault#malformed', () => {}), null)
})

test('public open omits credentials/referrers and never transmits the decryption key', async t => {
  const f = await fixture(t)
  const id = randomUUID()
  const prepared = await vault.createShare(f.entry, f.created.opened, id)
  const share = { id, entryId: f.entry.id, ownerId: f.user.id, descriptor: f.entry.descriptor, envelope: prepared.envelope, expiresAt: Date.now() + 60000 }
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, '/api/vault/public/open')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.deepEqual(JSON.parse(options.body), { id, token: prepared.token })
    assert.ok(!options.body.includes(prepared.keyFragment))
    assert.ok(!String(url).includes(prepared.token))
    return json({ share })
  }
  const opened = await client.openPublicVault({ id, token: prepared.token, keyFragment: prepared.keyFragment })
  assert.equal(opened.opened.name, f.file.name)
  assert.equal(calls, 1)
  opened.close()
})

test('bounded encrypted readers reject excess, truncated and oversized declared responses', async t => {
  const prior = globalThis.fetch
  t.after(() => { globalThis.fetch = prior })
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(33)) }, cancel() { cancelled = true },
  }))
  await assert.rejects(client.readVaultChunk('vault/entries/test/chunks/0', 32), /incomplete or damaged/)
  assert.equal(cancelled, true)
  globalThis.fetch = async () => new Response(new Uint8Array(31))
  await assert.rejects(client.readVaultChunk('vault/entries/test/chunks/0', 32), /incomplete or damaged/)
  globalThis.fetch = async () => new Response(new Uint8Array(32), { headers: { 'Content-Length': '999999999' } })
  await assert.rejects(client.readVaultChunk('vault/entries/test/chunks/0', 32), /incomplete or damaged/)
  let fetched = false
  globalThis.fetch = async () => { fetched = true; throw new Error('must not request an unbounded chunk') }
  await assert.rejects(client.readVaultChunk('vault/entries/test/chunks/0', vault.CHUNK_SIZE + 29))
  assert.equal(fetched, false)
})

test('upload retries reuse identical ciphertext and successful uploads can immediately be shared', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 19).fill(42))
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  const bodies = []
  let initial, retried = false, completed = false, shared = false
  globalThis.fetch = async (url, options) => {
    if (url === '/api/vault/entries') {
      initial = JSON.parse(options.body)
      assert.ok(!options.body.includes(f.file.name))
      assert.ok(!options.body.includes('text/plain'))
      return json({ entry: { ...initial, state: 'uploading' } })
    }
    if (/\/chunks\/0$/u.test(url)) {
      bodies.push(Buffer.from(options.body))
      if (!retried) { retried = true; return new Response('{"error":"retry"}', { status: 503 }) }
      return json({})
    }
    if (/\/chunks\/1$/u.test(url)) return json({})
    if (url.endsWith('/complete')) { completed = true; return json({}) }
    if (url.endsWith('/shares')) {
      const body = JSON.parse(options.body)
      assert.ok(body.envelope)
      assert.ok(body.ownerEnvelope)
      assert.ok(body.tokenHash)
      assert.ok(!Object.hasOwn(body, 'token'))
      assert.ok(!Object.hasOwn(body, 'keyFragment'))
      shared = true
      return json({})
    }
    throw new Error('Unexpected endpoint: ' + url)
  }
  const entry = await service.upload(f.file, null)
  assert.equal(entry.id, initial.id)
  assert.equal(entry.state, 'ready')
  assert.ok(entry.envelope)
  assert.ok(completed)
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0], bodies[1])
  const link = await service.createShare(entry)
  assert.ok(shared)
  assert.match(link.url, /\/vault#[a-f0-9-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
})

test('rejected reservations and failed uploads clean only their new entry', async t => {
  const f = await fixture(t)
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  let createdId, deletedId
  globalThis.fetch = async (url, options) => {
    if (url === '/api/vault/entries') {
      createdId = JSON.parse(options.body).id
      return new Response('{"error":"quota exceeded"}', { status: 413 })
    }
    if (options.method === 'DELETE') { deletedId = url.split('/').at(-1); return new Response(null, { status: 204 }) }
    throw new Error('Unexpected endpoint: ' + url)
  }
  await assert.rejects(service.upload(f.file, null), /quota exceeded/)
  assert.ok(createdId)
  assert.equal(deletedId, createdId)
})

test('verified downloads commit only complete authenticated files and abort on tampering', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 19).fill(77))
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const second = await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE))
  const opened = await vault.openEntry(f.user, f.entry)
  const writes = []
  let closed = false, aborted = false
  const destination = { handle: { async createWritable() { return {
    async write(bytes) { writes.push(Buffer.from(bytes)) }, async close() { closed = true }, async abort() { aborted = true; writes.length = 0 },
  } } }, name: f.file.name }
  await client.saveVaultFile(opened, index => Promise.resolve(index ? second : first), { prepared: Promise.resolve(destination) })
  assert.equal(closed, true); assert.equal(aborted, false)
  assert.deepEqual(Buffer.concat(writes), Buffer.from(f.data))
  writes.length = 0; closed = false
  const changed = new Uint8Array(second); changed[20] ^= 1
  await assert.rejects(client.saveVaultFile(opened, index => Promise.resolve(index ? changed : first), { prepared: Promise.resolve(destination) }))
  assert.equal(closed, false); assert.equal(aborted, true); assert.equal(writes.length, 0)
})

test('large downloads never silently fall back to accumulating the whole file in memory', async t => {
  const f = await fixture(t)
  const created = await vault.createFile(f.user, randomUUID(), { name: 'large.bin', type: '', size: client.BLOB_DOWNLOAD_LIMIT + 1, lastModified: 0 })
  const prior = globalThis.showSaveFilePicker
  delete globalThis.showSaveFilePicker
  t.after(() => { if (prior !== undefined) globalThis.showSaveFilePicker = prior })
  await assert.rejects(client.prepareVaultDownload(created.opened), /128 MiB/)
  let read = false
  await assert.rejects(client.saveVaultFile(created.opened, () => { read = true }, { prepared: Promise.resolve({ name: 'large.bin' }) }), /128 MiB/)
  assert.equal(read, false)
})

test('folder destinations exclude descendants and names reject path/control/bidi spoofing', () => {
  assert.equal(helpers.vaultSafeName('../private'), null)
  assert.equal(helpers.vaultSafeName('file\\private'), null)
  assert.equal(helpers.vaultSafeName('secret\u202etxt.exe'), null)
  assert.equal(helpers.vaultSafeName('计划.txt'), '计划.txt')
  assert.equal(helpers.vaultSafeName('😀'.repeat(64)), null)
  const entries = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'sibling', parentId: null }]
  assert.deepEqual([...helpers.vaultDescendants(entries, 'a')].sort(), ['a', 'b', 'c'])
})

test('cancelling a verified file download aborts its partial output before requesting more chunks', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 3).fill(19))
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const opened = await vault.openEntry(f.user, f.entry)
  const controller = new AbortController()
  let reads = 0, closed = false, aborted = false
  const destination = { handle: { async createWritable() { return {
    async write() { controller.abort() }, async close() { closed = true }, async abort() { aborted = true },
  } } } }
  await assert.rejects(client.saveVaultFile(opened, () => { reads++; return Promise.resolve(first) },
    { prepared: Promise.resolve(destination), signal: controller.signal }), { name: 'AbortError' })
  assert.equal(reads, 1)
  assert.equal(closed, false)
  assert.equal(aborted, true)
})

test('closing a vault revokes decrypted browser download objects', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const opened = await vault.openEntry(f.user, f.entry)
  const oldDocument = globalThis.document, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, oldTimer = globalThis.setTimeout
  const revoked = []
  let clicked = false
  globalThis.document = { ...oldDocument, body: { append() {} }, createElement() { return { click() { clicked = true }, remove() {} } } }
  URL.createObjectURL = () => 'blob:https://rooms.example.test/private-download'
  URL.revokeObjectURL = value => revoked.push(value)
  globalThis.setTimeout = () => 0
  t.after(() => { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; globalThis.setTimeout = oldTimer })
  const service = client.createVaultClient({ user: f.user })
  await client.saveVaultFile(opened, () => Promise.resolve(encrypted), { prepared: Promise.resolve({ name: f.file.name }) })
  assert.equal(clicked, true)
  assert.deepEqual(revoked, [])
  service.close()
  assert.deepEqual(revoked, ['blob:https://rooms.example.test/private-download'])
})

test('owner cache hits never bypass changed identity, kind or explicit null owner context', async t => {
  const f = await fixture(t)
  let entry = { ...f.entry }
  delete entry.ownerId
  globalThis.fetch = async () => json({ enabled: true, entries: [entry], receivedShares: [] })
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  assert.equal((await service.list()).entries[0].name, f.file.name)
  entry = { ...entry, ownerId: null }
  assert.equal((await service.list()).entries[0].locked, true)
  entry = { ...entry, ownerId: f.user.id }
  assert.equal((await service.list()).entries[0].name, f.file.name)
  entry = { ...entry, ownerId: randomUUID() }
  assert.equal((await service.list()).entries[0].locked, true)
  entry = { ...entry, ownerId: f.user.id, kind: 'folder' }
  assert.equal((await service.list()).entries[0].locked, true)
  entry = { ...entry, kind: 'file' }
  assert.equal((await service.list()).entries[0].name, f.file.name)
})

test('member cache hits recheck recipient and authenticated owner context including owner key changes', async t => {
  const f = await fixture(t)
  const window = {}
  runInNewContext(accountScript, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } })
  const registration = await window.ClubCrypto.prepareRegistration('vault-recipient', 'A long recipient vault passphrase')
  const user = { id: randomUUID(), username: 'vault-recipient', publicKey: registration.publicKey, identity: registration.identity }
  await window.ClubCrypto.unlock(user, 'A long recipient vault passphrase')
  const shareId = randomUUID()
  const envelope = await vault.sealMemberShare(f.user, f.entry, f.created.opened, shareId, user)
  globalThis.ClubCrypto = window.ClubCrypto
  const original = { id: shareId, ownerId: f.user.id, entryId: f.entry.id, recipientId: user.id,
    descriptor: f.entry.descriptor, envelope, owner: { id: f.user.id, publicKey: f.user.publicKey } }
  let share = original
  globalThis.fetch = async () => json({ enabled: true, entries: [], receivedShares: [share] })
  const service = client.createVaultClient({ user })
  t.after(() => service.close())
  assert.equal((await service.list()).receivedEntries[0].name, f.file.name)
  share = { ...original, owner: { ...original.owner, id: randomUUID() } }
  assert.equal((await service.list()).receivedEntries[0].locked, true)
  share = { ...original, owner: { ...original.owner, publicKey: user.publicKey } }
  assert.equal((await service.list()).receivedEntries[0].locked, true)
  share = { ...original, recipientId: randomUUID() }
  assert.equal((await service.list()).receivedEntries[0].locked, true)
  share = original
  assert.equal((await service.list()).receivedEntries[0].name, f.file.name)
})

test('partial file-manager integration remains removable and offers updating newly detected managers', () => {
  const managers = ['nautilus', 'nemo', 'caja', 'dolphin', 'thunar']
  assert.deepEqual(helpers.vaultIntegrationState({ managers, installed: true, installedManagers: ['nautilus'] }),
    { any: true, complete: false, partial: true })
  assert.deepEqual(helpers.vaultIntegrationState({ managers, installed: true, installedManagers: managers }),
    { any: true, complete: true, partial: false })
  assert.deepEqual(helpers.vaultIntegrationState({ managers: [], installed: true, installedManagers: ['nautilus'] }),
    { any: true, complete: false, partial: true })
  assert.deepEqual(helpers.vaultIntegrationState({ managers: ['windows'], installed: false, anyInstalled: true }),
    { any: true, complete: false, partial: true })
})

test('save-file suggestions neutralize Windows reserved names and characters without changing file data', async t => {
  const f = await fixture(t)
  const previous = globalThis.showSaveFilePicker
  let suggestion
  globalThis.showSaveFilePicker = async options => { suggestion = options.suggestedName; return {} }
  t.after(() => { if (previous === undefined) delete globalThis.showSaveFilePicker; else globalThis.showSaveFilePicker = previous })
  for (const name of ['CON', 'prn.txt', 'AUX.zip', 'NUL', 'COM0.log', 'COM9.txt', 'LPT1.pdf', 'COM¹.txt', 'CONIN$']) {
    await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name })
    assert.equal(suggestion, '_' + name)
  }
  await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name: 'report:*?"<>|.txt' })
  assert.ok(!/[:*?"<>|]/u.test(suggestion))
  await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name: 'a'.repeat(239) + '.' + 'b'.repeat(10) })
  assert.ok(!/[. ]$/u.test(suggestion))
  assert.equal(f.file.name, 'private-plan-计划.txt')
})

test('declining native ZIP confirmation keeps the original selection available', async () => {
  const cancelled = []
  const bridge = { prepareArchive: async () => null, cancelArchive: async id => cancelled.push(id) }
  await assert.rejects(client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }), { name: 'AbortError' })
  assert.deepEqual(cancelled, [])
})

test('explicit transfer cancellation stops native planning before an archive ID exists', async () => {
  const controller = new AbortController(), cancelled = []
  let finishPrepare
  const bridge = { prepareArchive: () => new Promise(resolve => { finishPrepare = resolve }),
    cancelArchive: async id => { cancelled.push(id); finishPrepare(null) } }
  const pending = client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(cancelled, [undefined])
})

test('native ZIP adapter reads only the approved handle sequentially and cleans it after upload', async () => {
  const cancelled = [], reads = []
  const archive = { id: 'approved-id', name: 'Selection.zip', type: 'application/zip', size: 5 }
  const bridge = { prepareArchive: async (...args) => { assert.deepEqual(args, []); return archive },
    readArchive: async (id, offset, length) => { reads.push([id, offset, length]);
      return offset === 0 ? new Uint8Array([99, 9, 8, 99]).subarray(1, 3) : new Uint8Array([7, 6, 5]) },
    cancelArchive: async id => cancelled.push(id) }
  const service = { async upload(file, parentId) {
    assert.equal(file.name, archive.name); assert.equal(file.size, 5); assert.equal(file.type, 'application/zip'); assert.equal(parentId, 'destination')
    assert.deepEqual(new Uint8Array(await file.slice(0, 2).arrayBuffer()), new Uint8Array([9, 8]))
    assert.deepEqual(new Uint8Array(await file.slice(2, 5).arrayBuffer()), new Uint8Array([7, 6, 5]))
    return { id: 'uploaded-entry' }
  } }
  assert.deepEqual(await client.uploadNativeVaultSelection(bridge, service, { parentId: 'destination' }), { id: 'uploaded-entry' })
  assert.deepEqual(reads, [['approved-id', 0, 2], ['approved-id', 2, 3]])
  assert.deepEqual(cancelled, ['approved-id'])
})

test('default-disabled vault routes return a disabled view without loading file metadata', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  const calls = []
  globalThis.fetch = async url => { calls.push(url); assert.equal(url, '/api/vault/config'); return json({ enabled: false, quotaBytes: 2 * 1024 ** 3 }) }
  const service = client.createVaultClient({ user: { id: randomUUID() } })
  t.after(() => service.close())
  const result = await service.list()
  assert.equal(result.enabled, false)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.receivedEntries, [])
  assert.deepEqual(calls, ['/api/vault/config'])
})

test('disabling vault between config and listing becomes a disabled view instead of a stale error', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  const calls = []
  globalThis.fetch = async url => {
    calls.push(url)
    if (url === '/api/vault/config') return json({ enabled: calls.length === 1, quotaBytes: 2 * 1024 ** 3 })
    return new Response('{"error":"unavailable"}', { status: 404 })
  }
  const service = client.createVaultClient({ user: { id: randomUUID() } })
  t.after(() => service.close())
  const result = await service.list()
  assert.equal(result.enabled, false)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(calls, ['/api/vault/config', '/api/vault', '/api/vault/config'])
})

function nativeSaveFixture(t) {
  const oldNative = globalThis.roomsVault, oldPicker = globalThis.showSaveFilePicker
  const calls = [], output = []
  let completed = false
  globalThis.showSaveFilePicker = () => { throw new Error('browser filesystem permission must not be requested in desktop') }
  const bridge = {
    async prepareDownload(input) { calls.push(['prepare', input]); return { id: 'opaque-native-save' } },
    async writeDownload(id, offset, bytes) { calls.push(['write', id, offset, bytes.byteLength]); output.push(Buffer.from(bytes)); return true },
    async completeDownload(id) { calls.push(['complete', id]); completed = true; return true },
    async cancelDownload(id) { calls.push(['cancel', id]); output.length = 0; return true },
  }
  globalThis.roomsVault = bridge
  t.after(() => {
    if (oldNative === undefined) delete globalThis.roomsVault; else globalThis.roomsVault = oldNative
    if (oldPicker === undefined) delete globalThis.showSaveFilePicker; else globalThis.showSaveFilePicker = oldPicker
  })
  return { bridge, calls, output, completed: () => completed }
}

test('desktop native save is preferred and commits only verified sequential chunks', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 9).fill(39))
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const second = await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE))
  const opened = await vault.openEntry(f.user, f.entry), native = nativeSaveFixture(t)
  const prepared = client.prepareVaultDownload(opened)
  assert.deepEqual(native.calls[0], ['prepare', { name: f.file.name, size: f.file.size }])
  await client.saveVaultFile(opened, index => Promise.resolve(index ? second : first), { prepared })
  assert.equal(native.completed(), true)
  assert.deepEqual(Buffer.concat(native.output), Buffer.from(f.data))
  assert.deepEqual(native.calls.filter(call => call[0] === 'write'), [
    ['write', 'opaque-native-save', 0, vault.CHUNK_SIZE], ['write', 'opaque-native-save', vault.CHUNK_SIZE, 9],
  ])
  assert.deepEqual(native.calls.at(-1), ['complete', 'opaque-native-save'])
})

test('native desktop save supports large descriptors without a full-file memory fallback', async t => {
  const f = await fixture(t), native = nativeSaveFixture(t)
  const created = await vault.createFile(f.user, randomUUID(), { name: 'large.bin', type: '', size: 2 * 1024 ** 3, lastModified: 0 })
  const prepared = await client.prepareVaultDownload(created.opened)
  assert.ok(prepared.handle)
  assert.deepEqual(native.calls[0], ['prepare', { name: 'large.bin', size: 2 * 1024 ** 3 }])
  await prepared.abort()
  assert.deepEqual(native.calls.at(-1), ['cancel', 'opaque-native-save'])
})

test('abort while the native save picker is pending cleans the late handle before writing', async t => {
  const f = await fixture(t), native = nativeSaveFixture(t), controller = new AbortController()
  let choose
  native.bridge.prepareDownload = () => new Promise(resolve => { choose = resolve })
  const prepared = client.prepareVaultDownload(f.created.opened)
  let requested = false
  const saving = client.saveVaultFile(f.created.opened, () => { requested = true }, { prepared, signal: controller.signal })
  controller.abort(); choose({ id: 'opaque-late-save' })
  await assert.rejects(saving, { name: 'AbortError' })
  assert.equal(requested, false)
  assert.deepEqual(native.calls, [['cancel', 'opaque-late-save']])
})

test('native desktop save cancels partial output on authentication failure and handles empty files', async t => {
  const f = await fixture(t), native = nativeSaveFixture(t)
  const cipher = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  cipher[15] ^= 1
  await assert.rejects(client.saveVaultFile(f.created.opened, () => Promise.resolve(cipher), { prepared: client.prepareVaultDownload(f.created.opened) }))
  assert.equal(native.completed(), false)
  assert.deepEqual(native.calls.at(-1), ['cancel', 'opaque-native-save'])
  const empty = await vault.createFile(f.user, randomUUID(), new File([], 'empty.bin'))
  const encrypted = await vault.encryptChunk(empty.secret, empty.descriptor, 0, new Uint8Array())
  const before = native.calls.length
  await client.saveVaultFile(empty.opened, () => Promise.resolve(encrypted), { prepared: client.prepareVaultDownload(empty.opened) })
  assert.equal(native.completed(), true)
  assert.ok(!native.calls.slice(before).some(call => call[0] === 'write'))
})

test('native save names bound final UTF-8 bytes including device prefixes and remove C1 controls', async t => {
  const f = await fixture(t), native = nativeSaveFixture(t)
  const original = 'CON.' + '界'.repeat(83) + 'aa'
  assert.equal(new TextEncoder().encode(original).byteLength, 255)
  const destination = await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name: original })
  const suggestion = native.calls[0][1].name
  assert.ok(suggestion.startsWith('_CON.'))
  assert.ok(new TextEncoder().encode(suggestion).byteLength <= 240)
  assert.ok(!/[\ud800-\udfff]/u.test(suggestion))
  await destination.abort()
  const controlled = await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name: 'private\u0085\u009f.txt' })
  assert.equal(native.calls.at(-1)[1].name, 'private__.txt')
  await controlled.abort()
  const supplementary = await client.prepareVaultDownload({ descriptor: f.entry.descriptor, name: '😀'.repeat(63) + '.txt' })
  const unicode = native.calls.at(-1)[1].name
  assert.ok(new TextEncoder().encode(unicode).byteLength <= 240)
  assert.ok(/^(?:😀)+$/u.test(unicode), 'truncation preserves whole Unicode code points')
  await supplementary.abort()
  assert.equal(original, 'CON.' + '界'.repeat(83) + 'aa')
})
