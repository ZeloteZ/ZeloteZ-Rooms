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
async function fixture(t, data = encode('Private file contents'), { name = 'private-plan-计划.txt', type = 'text/plain' } = {}) {
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
  const file = new File([data], name, { type, lastModified: 1700000000000 })
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

test('public room previews decrypt verified bytes locally with no credentials or key transmission and abort on close', async t => {
  const f = await fixture(t), id = randomUUID()
  const shared = await vault.createShare(f.entry, f.created.opened, id)
  const share = { id, entryId: f.entry.id, ownerId: f.user.id, descriptor: f.entry.descriptor, envelope: shared.envelope }
  const ciphertext = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.data)
  let reads = 0
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.ok(!JSON.stringify(options).includes(shared.keyFragment))
    if (url === '/api/vault/public/open') return json({ share })
    assert.equal(url, '/api/vault/public/' + id + '/chunks/0')
    assert.equal(options.headers.Authorization, 'Bearer ' + shared.token)
    reads++
    return new Response(ciphertext)
  }
  const opened = await client.openPublicVault({ id, token: shared.token, keyFragment: shared.keyFragment })
  const blob = await opened.readBlob()
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), f.data)
  assert.equal(reads, 1)
  opened.close()
  await assert.rejects(opened.readBlob(), { name: 'AbortError' })
  assert.equal(reads, 1)
})

test('public preview bounds reject large reads before fetching any encrypted chunk', async t => {
  const f = await fixture(t), id = randomUUID()
  const shared = await vault.createShare(f.entry, f.created.opened, id)
  const share = { id, entryId: f.entry.id, ownerId: f.user.id, descriptor: f.entry.descriptor, envelope: shared.envelope }
  let requests = 0
  globalThis.fetch = async url => { assert.equal(url, '/api/vault/public/open'); requests++; return json({ share }) }
  const opened = await client.openPublicVault({ id, token: shared.token, keyFragment: shared.keyFragment })
  await assert.rejects(opened.readBlob({ maxBytes: f.data.byteLength - 1 }), /too large/u)
  assert.equal(requests, 1)
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
  assert.deepEqual(helpers.vaultIntegrationState({ managers: ['nautilus'], installed: true,
    installedManagers: ['nautilus'], migrationManagers: ['nautilus'] }),
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

test('declining native selection confirmation keeps the original selection available', async () => {
  const cancelled = []
  const bridge = { prepareSelection: async () => null, cancelSelection: async id => cancelled.push(id),
    readSelection() { throw new Error('must not read') } }
  await assert.rejects(client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }), { name: 'AbortError' })
  assert.deepEqual(cancelled, [])
})

test('explicit transfer cancellation stops native planning before a selection ID exists', async () => {
  const controller = new AbortController(), cancelled = []
  let finishPrepare
  const bridge = { prepareSelection: () => new Promise(resolve => { finishPrepare = resolve }),
    cancelSelection: async id => { cancelled.push(id); finishPrepare(null) }, readSelection() { throw new Error('must not read') } }
  const pending = client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(cancelled, [undefined])
})

test('native file adapter preserves the original name and reads only bounded approved ranges', async () => {
  const cancelled = [], reads = []
  const first = new Uint8Array([99, 9, 8, 99]), second = new Uint8Array([7, 6, 5])
  const selected = { id: randomUUID(), name: 'Clip.mp4', type: 'video/mp4', size: 5, lastModified: 1700000000000 }
  const selection = { id: randomUUID(), files: [selected] }
  const bridge = { prepareSelection: async (...args) => { assert.deepEqual(args, []); return selection },
    readSelection: async (id, offset, length) => { reads.push([id, offset, length]);
      return offset === 0 ? first.subarray(1, 3) : second },
    cancelSelection: async id => cancelled.push(id) }
  const service = { async upload(file, parentId) {
    assert.equal(file.name, 'Clip.mp4'); assert.equal(file.size, 5); assert.equal(file.type, 'video/mp4'); assert.equal(parentId, 'destination')
    assert.equal(file.lastModified, selected.lastModified)
    assert.deepEqual(new Uint8Array(await file.slice(0, 2).arrayBuffer()), new Uint8Array([9, 8]))
    assert.deepEqual(new Uint8Array(await file.slice(2, 5).arrayBuffer()), new Uint8Array([7, 6, 5]))
    return { id: 'uploaded-entry' }
  } }
  assert.deepEqual(await client.uploadNativeVaultSelection(bridge, service, { parentId: 'destination' }), [{ id: 'uploaded-entry' }])
  assert.deepEqual(reads, [[selected.id, 0, 2], [selected.id, 2, 3]])
  assert.deepEqual(cancelled, [selection.id])
  assert.deepEqual(first, new Uint8Array([99, 0, 0, 99]))
  assert.deepEqual(second, new Uint8Array(3))
})

test('old desktop versions require an update without silently archiving files', async () => {
  const bridge = { prepareArchive() { throw new Error('must not use the old ZIP fallback') } }
  await assert.rejects(client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }), /Update the desktop app/u)
})

test('mixed native selections become separate E2EE entries after one confirmation, including empty files', async t => {
  const f = await fixture(t), service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  const inputs = [
    { id: randomUUID(), name: 'Original 计划.txt', type: 'text/plain', data: encode('Original private text'), lastModified: 1700000000000 },
    { id: randomUUID(), name: 'Holiday.zip', type: 'application/zip', data: new Uint8Array([80, 75, 3, 4, 8, 7]) },
    { id: randomUUID(), name: 'empty.bin', type: 'application/octet-stream', data: new Uint8Array() },
  ]
  const selection = { id: randomUUID(), files: inputs.map(({ data, ...item }) => ({ ...item, size: data.length })) }
  const reads = [], cancelled = [], snapshots = [], encrypted = new Map(), notifications = [], progress = []
  let prepared = 0, activeId
  const bridge = {
    async prepareSelection(...args) { prepared++; assert.deepEqual(args, []); return selection },
    async readSelection(id, offset, length) {
      reads.push([id, offset, length])
      const input = inputs.find(item => item.id === id)
      assert.ok(input); assert.ok(length <= vault.CHUNK_SIZE)
      return input.data.slice(offset, offset + length)
    },
    async cancelSelection(id) { cancelled.push(id) },
  }
  globalThis.fetch = async (url, options) => {
    if (url === '/api/vault/entries') {
      const body = JSON.parse(options.body)
      assert.equal(activeId, undefined, 'uploads must finish sequentially')
      activeId = body.id; snapshots.push(body)
      for (const input of inputs) assert.ok(!options.body.includes(input.name), 'names must be encrypted before upload')
      return json({ entry: { ...body, state: 'uploading' } })
    }
    if (url === '/api/vault/entries/' + activeId + '/chunks/0') {
      const bytes = new Uint8Array(options.body)
      const source = inputs[snapshots.length - 1].data
      assert.equal(bytes.length, source.length + 28)
      assert.notDeepEqual(bytes, source)
      encrypted.set(activeId, bytes)
      return json({})
    }
    if (url === '/api/vault/entries/' + activeId + '/complete') { activeId = undefined; return json({}) }
    throw new Error('Unexpected endpoint: ' + url)
  }
  const uploaded = await client.uploadNativeVaultSelection(bridge, service, { onUploaded: entry => notifications.push(entry), onProgress: value => progress.push(value) })
  assert.equal(prepared, 1)
  assert.deepEqual(uploaded.map(entry => [entry.name, entry.type]), inputs.map(item => [item.name, item.type]))
  assert.deepEqual(notifications, uploaded)
  assert.equal(new Set(snapshots.map(entry => entry.descriptor.contentId)).size, inputs.length)
  assert.deepEqual(reads, inputs.map(item => [item.id, 0, item.data.length]))
  assert.deepEqual(cancelled, [selection.id])
  assert.equal(progress.at(-1).done, progress.at(-1).total)
  assert.deepEqual([...new Set(progress.map(value => value.fileName))], inputs.map(item => item.name))
  for (const [index, entry] of uploaded.entries()) {
    const opened = await vault.openEntry(f.user, entry)
    assert.deepEqual(await vault.decryptChunk(opened.secret, entry.descriptor, 0, encrypted.get(entry.id)), inputs[index].data)
    vault.destroySecret(opened.secret)
  }
})

test('later native upload failures retain completed entries and stop the remaining selection', async () => {
  const selection = { id: randomUUID(), files: ['one.txt', 'two.txt', 'three.txt'].map(name => ({ id: randomUUID(), name, size: 1, type: 'text/plain' })) }
  const cancelled = [], uploaded = [], started = []
  const bridge = { prepareSelection: async () => selection, readSelection: async () => new Uint8Array([7]),
    cancelSelection: async id => cancelled.push(id) }
  const service = { async upload(file) {
    started.push(file.name)
    if (file.name === 'two.txt') throw new Error('quota exceeded')
    return { id: randomUUID(), name: file.name }
  } }
  await assert.rejects(client.uploadNativeVaultSelection(bridge, service, { onUploaded: entry => uploaded.push(entry) }), /quota exceeded/u)
  assert.deepEqual(started, ['one.txt', 'two.txt'])
  assert.deepEqual(uploaded.map(entry => entry.name), ['one.txt'])
  assert.deepEqual(cancelled, [selection.id])
})

test('native transfer cancellation retains a completed item without starting the next one', async () => {
  const controller = new AbortController(), cancelled = [], uploaded = [], started = []
  const selection = { id: randomUUID(), files: ['one.txt', 'two.txt'].map(name => ({ id: randomUUID(), name, size: 1, type: 'text/plain' })) }
  const bridge = { prepareSelection: async () => selection, readSelection: async () => new Uint8Array([7]), cancelSelection: async id => cancelled.push(id) }
  const service = { async upload(file) { started.push(file.name); return { id: randomUUID(), name: file.name } } }
  await assert.rejects(client.uploadNativeVaultSelection(bridge, service, { signal: controller.signal,
    onUploaded(entry) { uploaded.push(entry); controller.abort() } }), { name: 'AbortError' })
  assert.deepEqual(started, ['one.txt'])
  assert.deepEqual(uploaded.map(entry => entry.name), ['one.txt'])
  assert.ok(cancelled.length >= 1)
  assert.ok(cancelled.every(id => id === selection.id))
})

test('cancelling a pending native read wipes late plaintext before it can reach the upload encryptor', async () => {
  const controller = new AbortController(), bytes = new Uint8Array([17, 18, 19])
  const selection = { id: randomUUID(), files: [{ id: randomUUID(), name: 'private.txt', type: 'text/plain', size: 3 }] }
  let releaseRead, announceRead
  const reading = new Promise(resolve => { announceRead = resolve })
  const bridge = { prepareSelection: async () => selection, readSelection() {
    announceRead(); return new Promise(resolve => { releaseRead = resolve })
  }, cancelSelection: async () => {} }
  const service = { async upload(file) { await file.slice(0, 3).arrayBuffer(); throw new Error('must not receive plaintext') } }
  const pending = client.uploadNativeVaultSelection(bridge, service, { signal: controller.signal })
  await reading; controller.abort(); releaseRead(bytes)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(bytes, new Uint8Array(3))
})

test('malformed native descriptors and oversized or truncated reads fail before uploading unapproved bytes', async () => {
  const valid = { id: randomUUID(), name: 'safe.txt', type: 'text/plain', size: 1 }
  for (const files of [[valid, valid], [{ ...valid, name: '../unsafe.txt' }], [{ ...valid, size: vault.MAX_FILE_SIZE + 1 }], [{ ...valid, type: 'text/plain\n' }]]) {
    const selection = { id: randomUUID(), files }, cancelled = []
    const bridge = { prepareSelection: async () => selection, readSelection() { throw new Error('must not read') }, cancelSelection: async id => cancelled.push(id) }
    await assert.rejects(client.uploadNativeVaultSelection(bridge, { upload() { throw new Error('must not upload') } }))
    assert.deepEqual(cancelled, [selection.id])
  }
  for (const [start, end, response] of [[-1, 1, new Uint8Array()], [0, 2, new Uint8Array(2)], [0, 1, new Uint8Array()], [0, 1, new Uint8Array(2)], [0, 1, 'not bytes']]) {
    const selection = { id: randomUUID(), files: [valid] }, cancelled = [], reads = []
    const bridge = { prepareSelection: async () => selection, readSelection: async (...args) => { reads.push(args); return response }, cancelSelection: async id => cancelled.push(id) }
    await assert.rejects(client.uploadNativeVaultSelection(bridge, { async upload(file) { await file.slice(start, end).arrayBuffer() } }), /local selection/u)
    assert.equal(reads.length, start < 0 || end > valid.size ? 0 : 1)
    assert.deepEqual(cancelled, [selection.id])
  }
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

test('local editor reads only complete authenticated blobs without download objects or save dialogs', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 13).fill(73))
  const encrypted = [
    await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE)),
    await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE)),
  ]
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  const previousCreate = URL.createObjectURL, previousPicker = globalThis.showSaveFilePicker
  URL.createObjectURL = () => { throw new Error('must not create a decrypted download URL') }
  globalThis.showSaveFilePicker = () => { throw new Error('must not prompt for a download') }
  t.after(() => { URL.createObjectURL = previousCreate; if (previousPicker === undefined) delete globalThis.showSaveFilePicker; else globalThis.showSaveFilePicker = previousPicker })
  const entry = { ...f.entry, type: 'text/html' }, paths = [], progress = []
  globalThis.fetch = async (path, options) => {
    paths.push(path)
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(options.redirect, 'error')
    if (paths.length === 1) entry.id = randomUUID()
    return new Response(encrypted[paths.length - 1])
  }
  const blob = await service.readBlob(entry, { onProgress: value => progress.push(value.done) })
  assert.equal(blob.type, 'text/plain', 'metadata type must be authenticated, not taken from a changed UI row')
  assert.equal(blob.size, f.data.byteLength)
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from(f.data))
  assert.deepEqual(paths, [0, 1].map(index => `/api/vault/entries/${f.entry.id}/chunks/${index}`))
  assert.deepEqual(progress, [vault.CHUNK_SIZE, f.data.byteLength])
})

test('local editor enforces hard and caller memory limits before any file request', async t => {
  const f = await fixture(t)
  const large = await vault.createFile(f.user, randomUUID(), { name: 'large.mp4', type: 'video/mp4', size: client.BLOB_DOWNLOAD_LIMIT + 1, lastModified: 0 })
  const entry = { id: large.descriptor.id, kind: 'file', state: 'ready', descriptor: large.descriptor, envelope: large.envelope }
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch a file above the preview limit') }
  await assert.rejects(service.readBlob(entry), /too large/)
  await assert.rejects(service.readBlob(f.entry, { maxBytes: 2 }), /too large/)
  for (const maxBytes of [-1, Infinity, 1.5, client.BLOB_DOWNLOAD_LIMIT + 1]) {
    await assert.rejects(service.readBlob(f.entry, { maxBytes }), /memory limit/)
  }
  await assert.rejects(service.readBlob({ ...f.entry, descriptor: { ...f.entry.descriptor, chunks: 999 } }))
  await assert.rejects(service.readBlob({ ...f.entry, state: 'uploading' }), /unavailable/)
  assert.equal(calls, 0)
})

test('local editor authenticates empty files and refuses tampered or cancelled partial plaintext', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 3).fill(19))
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const second = await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE))
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  const changed = new Uint8Array(second); changed[20] ^= 1
  let reads = 0
  globalThis.fetch = async () => new Response(++reads === 1 ? first : changed)
  await assert.rejects(service.readBlob(f.entry), /authenticated/)
  assert.equal(reads, 2)
  const controller = new AbortController(); reads = 0
  globalThis.fetch = async () => { reads++; return new Response(first) }
  await assert.rejects(service.readBlob(f.entry, { signal: controller.signal, onProgress() { controller.abort() } }), { name: 'AbortError' })
  assert.equal(reads, 1)
  const empty = await vault.createFile(f.user, randomUUID(), new File([], 'empty.txt', { type: 'text/plain' }))
  const emptyEntry = { id: empty.descriptor.id, kind: 'file', state: 'ready', envelope: empty.envelope, descriptor: empty.descriptor }
  const ciphertext = await vault.encryptChunk(empty.secret, empty.descriptor, 0, new Uint8Array())
  reads = 0
  globalThis.fetch = async () => { reads++; return new Response(ciphertext) }
  assert.equal((await service.readBlob(emptyEntry, { maxBytes: 0 })).size, 0)
  assert.equal(reads, 1, 'even an empty file must pass the server access check and authentication')
})

test('closing the client during an editor read never returns decrypted content', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const service = client.createVaultClient({ user: f.user })
  globalThis.fetch = async () => { service.close(); return new Response(encrypted) }
  await assert.rejects(service.readBlob(f.entry), { name: 'AbortError' })
  await assert.rejects(service.readBlob(f.entry), { name: 'AbortError' })
  await assert.rejects(service.saveEditedCopy(f.entry, new Blob(['edited'])), { name: 'AbortError' })
})

test('aborting the Vault lifetime immediately wipes cached raw file-key material', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const originalImport = crypto.subtle.importKey
  const rawKeys = []
  crypto.subtle.importKey = function(format, raw, algorithm, ...options) {
    if (format === 'raw' && algorithm === 'AES-GCM' && raw instanceof Uint8Array) rawKeys.push(raw)
    return originalImport.call(this, format, raw, algorithm, ...options)
  }
  t.after(() => { crypto.subtle.importKey = originalImport })
  const controller = new AbortController()
  const service = client.createVaultClient({ user: f.user, signal: controller.signal })
  t.after(() => service.close())
  globalThis.fetch = async () => new Response(encrypted)
  await service.readBlob(f.entry)
  assert.ok(rawKeys.some(value => value.some(byte => byte !== 0)))
  controller.abort()
  assert.ok(rawKeys.every(value => value.every(byte => byte === 0)))
  await assert.rejects(service.readBlob(f.entry), { name: 'AbortError' })
})

test('a denied editor read clears cached file secrets before subsequent reopening', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const originalOpen = globalThis.ClubCrypto.openVaultMessage
  let openings = 0
  globalThis.ClubCrypto.openVaultMessage = (...args) => { openings++; return originalOpen(...args) }
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  globalThis.fetch = async () => json({ enabled: true, entries: [f.entry], receivedShares: [] })
  await service.list(); assert.equal(openings, 1)
  globalThis.fetch = async () => new Response('{"error":"revoked or disabled"}', { status: 403 })
  await assert.rejects(service.readBlob(f.entry), /revoked or disabled/)
  globalThis.fetch = async () => new Response(encrypted)
  assert.equal((await service.readBlob(f.entry)).size, f.data.length)
  assert.equal(openings, 2)
})

test('saving edited copies uses fresh encrypted entries and never changes originals or shares', async t => {
  const f = await fixture(t)
  const parentId = randomUUID(), requests = [], reservations = [], ciphertexts = new Map()
  const source = { ...f.entry, parentId, name: 'untrusted-row-name.html' }
  const service = client.createVaultClient({ user: f.user })
  t.after(() => service.close())
  globalThis.fetch = async (path, options) => {
    requests.push({ path, method: options.method })
    if (path === '/api/vault/entries') {
      const entry = JSON.parse(options.body)
      reservations.push(entry)
      assert.equal(entry.parentId, parentId)
      assert.ok(!options.body.includes('Edited confidential contents'))
      assert.ok(!options.body.includes(f.file.name))
      return json({ entry: { ...entry, state: 'uploading' } })
    }
    if (/\/chunks\/0$/u.test(path)) { ciphertexts.set(path.split('/')[4], Buffer.from(options.body)); return json({}) }
    if (path.endsWith('/complete')) return json({})
    throw new Error('Unexpected mutation: ' + path)
  }
  const edited = new Blob(['Edited confidential contents'], { type: 'text/plain' })
  const first = await service.saveEditedCopy(source, edited)
  const second = await service.saveEditedCopy(source, edited)
  assert.notEqual(first.id, f.entry.id)
  assert.notEqual(second.id, first.id)
  assert.notEqual(first.descriptor.contentId, second.descriptor.contentId)
  assert.equal(first.name, 'private-plan-计划 (edited).txt')
  assert.equal(first.parentId, parentId)
  assert.ok(!requests.some(({ method, path }) => ['PATCH', 'DELETE'].includes(method) || path.includes('/shares') || path.includes(f.entry.id)))
  assert.notDeepEqual(ciphertexts.get(first.id), ciphertexts.get(second.id))
  const opened = await vault.openEntry(f.user, { ...first, ownerId: f.user.id })
  const decoded = await vault.decryptChunk(opened.secret, first.descriptor, 0, ciphertexts.get(first.id))
  assert.equal(new TextDecoder().decode(decoded), 'Edited confidential contents')
  assert.equal(source.name, 'untrusted-row-name.html')
  assert.equal(reservations.length, 2)
})

test('member files open through recipient access and edited copies belong to the recipient root', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const window = {}
  runInNewContext(accountScript, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } })
  const registration = await window.ClubCrypto.prepareRegistration('editor-recipient', 'A long editor recipient passphrase')
  const user = { id: randomUUID(), username: 'editor-recipient', publicKey: registration.publicKey, identity: registration.identity }
  await window.ClubCrypto.unlock(user, 'A long editor recipient passphrase')
  const shareId = randomUUID()
  const envelope = await vault.sealMemberShare(f.user, f.entry, f.created.opened, shareId, user)
  globalThis.ClubCrypto = window.ClubCrypto
  const share = { id: shareId, ownerId: f.user.id, entryId: f.entry.id, recipientId: user.id,
    descriptor: f.entry.descriptor, envelope, owner: { id: f.user.id, publicKey: f.user.publicKey } }
  const entry = { ...share, id: share.entryId, receivedShareId: shareId, share, kind: 'file', state: 'ready', parentId: null }
  const service = client.createVaultClient({ user })
  t.after(() => service.close())
  let reads = 0, saved
  globalThis.fetch = async (path, options) => {
    if (path === `/api/vault/received/${shareId}/chunks/0`) { reads++; return new Response(encrypted) }
    if (path === '/api/vault/entries') { saved = JSON.parse(options.body); return json({}) }
    if (path.startsWith('/api/vault/entries/') && (path.endsWith('/chunks/0') || path.endsWith('/complete'))) return json({})
    throw new Error('Unexpected endpoint: ' + path)
  }
  assert.equal(await (await service.readBlob(entry)).text(), await f.file.text())
  const result = await service.saveEditedCopy(entry, new Blob(['a recipient copy'], { type: 'text/plain' }), { parentId: randomUUID(), name: 'my-copy.txt' })
  assert.equal(reads, 1)
  assert.equal(saved.parentId, null)
  assert.equal(result.parentId, null)
  const reopened = await vault.openEntry(user, result)
  assert.equal(reopened.ownerId, user.id)
  assert.equal(reopened.name, 'my-copy.txt')
  await assert.rejects(service.readBlob({ ...entry, share: { ...share, recipientId: randomUUID() } }), /unavailable/)
  assert.equal(reads, 1)
})

test('edited copy names keep their extension inside the final UTF-8 byte limit', () => {
  const long = '界'.repeat(83) + 'aa.txt'
  assert.equal(new TextEncoder().encode(long).byteLength, 255)
  const name = client.editedVaultName(long)
  assert.ok(name.endsWith(' (edited).txt'))
  assert.ok(new TextEncoder().encode(name).byteLength <= 240)
  assert.equal(client.editedVaultName('CON.txt'), '_CON (edited).txt')
})

test('media previews build authenticated Blob fragments without reading or retaining a full plaintext array', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 13).fill(73), { name: 'Clip.mp4', type: 'video/mp4' })
  const encrypted = [await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE)),
    await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE))]
  const service = client.createVaultClient({ user: f.user }); t.after(() => service.close())
  const originalRead = Blob.prototype.arrayBuffer, originalDecrypt = crypto.subtle.decrypt
  const plaintext = [], probes = []; let reads = 0
  crypto.subtle.decrypt = async function(...args) {
    const buffer = await originalDecrypt.apply(this, args)
    if ([vault.CHUNK_SIZE, 13].includes(buffer.byteLength)) plaintext.push(new Uint8Array(buffer))
    return buffer
  }
  Blob.prototype.arrayBuffer = function() { assert.equal(this.size, 1, 'construction barriers read one real byte only'); probes.push(this.size); return originalRead.call(this) }
  t.after(() => { Blob.prototype.arrayBuffer = originalRead; crypto.subtle.decrypt = originalDecrypt })
  globalThis.fetch = async () => {
    assert.ok(plaintext.every(bytes => bytes.every(value => value === 0)), 'previous plaintext is wiped before the next chunk starts')
    return new Response(encrypted[reads++])
  }
  const blob = await service.readMediaBlob({ ...f.entry, type: 'text/plain', name: 'untrusted.txt' })
  assert.equal(blob.type, 'video/mp4'); assert.equal(blob.size, f.data.length); assert.equal(reads, 2)
  assert.equal(probes.length, 3); assert.equal(plaintext.length, 2); assert.ok(plaintext.every(bytes => bytes.every(value => value === 0)))
  Blob.prototype.arrayBuffer = originalRead
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), f.data)
})

test('media limits are separate from generic previews and cannot trust a spoofed row MIME', async t => {
  const f = await fixture(t), service = client.createVaultClient({ user: f.user }); t.after(() => service.close())
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('must not fetch an unsupported media file') }
  assert.equal(client.MEDIA_BLOB_LIMIT, 10 * 1024 ** 3)
  await assert.rejects(service.readMediaBlob({ ...f.entry, type: 'video/mp4', name: 'fake.mp4' }), /image, video or audio/u)
  for (const maxBytes of [-1, Infinity, .5, client.MEDIA_BLOB_LIMIT + 1]) await assert.rejects(service.readMediaBlob(f.entry, { maxBytes }), /memory limit/u)
  const large = await vault.createFile(f.user, randomUUID(), { name: 'large.mp4', type: 'video/mp4', size: client.MEDIA_BLOB_LIMIT + 1, lastModified: 0 })
  const entry = { id: large.descriptor.id, kind: 'file', state: 'ready', descriptor: large.descriptor, envelope: large.envelope }
  await assert.rejects(service.readMediaBlob(entry), /too large/u)
  await assert.rejects(service.readBlob(entry, {}, true), /too large/u)
  assert.equal(requests, 0)
})

test('media refreshes preserve folder moves while still enforcing authentication, removal and account cancellation', async t => {
  for (const change of ['move', 'move-and-tamper', 'remove', 'abort-account']) await t.test(change, async t => {
    const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 29).fill(61), { name: 'Moving-video.mp4', type: 'video/mp4' })
    const encrypted = [
      await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE)),
      await vault.encryptChunk(f.created.secret, f.created.descriptor, 1, f.data.subarray(vault.CHUNK_SIZE)),
    ]
    const account = new AbortController(), service = client.createVaultClient({ user: f.user, signal: account.signal })
    t.after(() => service.close())
    let entries = [f.entry], releaseSecond, markSecondRequested
    const secondRequested = new Promise(resolve => { markSecondRequested = resolve })
    const secondResponse = new Promise(resolve => { releaseSecond = resolve })
    const paths = [], progress = []
    globalThis.fetch = async (path, options) => {
      if (path === '/api/vault/config') return json({ enabled: true })
      if (path === '/api/vault') return json({ entries, receivedShares: [] })
      paths.push(path)
      assert.equal(options.credentials, 'same-origin')
      assert.equal(path, `/api/vault/entries/${f.entry.id}/chunks/${paths.length - 1}`)
      if (paths.length === 1) return new Response(encrypted[0])
      assert.equal(paths.length, 2)
      markSecondRequested()
      return new Response(await secondResponse)
    }
    const initial = (await service.list()).entries[0]
    const outcome = service.readMediaBlob(initial, { onProgress: value => progress.push(value.done) })
      .then(blob => ({ blob }), error => ({ error }))
    try {
      await secondRequested
      assert.deepEqual(progress, [vault.CHUNK_SIZE], 'the first authenticated chunk is complete before the refresh')
      if (change.startsWith('move')) {
        const parentId = randomUUID()
        entries = [{ ...f.entry, parentId }]
        const refreshed = (await service.list()).entries[0]
        assert.equal(refreshed.parentId, parentId)
        assert.equal(refreshed.name, f.file.name)
        assert.notEqual(initial.parentId, refreshed.parentId)
      } else if (change === 'remove') {
        entries = []
        assert.deepEqual((await service.list()).entries, [])
      } else account.abort()
      const second = new Uint8Array(encrypted[1])
      if (change === 'move-and-tamper') second[second.length - 1] ^= 1
      releaseSecond(second)
      const result = await outcome
      assert.equal(paths.length, 2)
      if (change === 'move') {
        assert.ifError(result.error)
        assert.equal(result.blob.type, 'video/mp4')
        assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), f.data)
        assert.deepEqual(progress, [vault.CHUNK_SIZE, f.data.length])
      } else {
        assert.equal(result.blob, undefined, 'partial authenticated data must never escape as a completed preview')
        if (change === 'move-and-tamper') assert.match(result.error?.message, /authenticated/u)
        else assert.equal(result.error?.name, 'AbortError')
        assert.deepEqual(progress, [vault.CHUNK_SIZE])
      }
    } finally {
      service.close()
      releaseSecond(encrypted[1])
      await outcome
    }
  })
})

test('the 10 GiB media boundary accepts authenticated chunks and aborts before fetching the next one', async t => {
  const f = await fixture(t), service = client.createVaultClient({ user: f.user }); t.after(() => service.close())
  const created = await vault.createFile(f.user, randomUUID(), { name: 'large.mkv', type: 'video/x-matroska', size: client.MEDIA_BLOB_LIMIT, lastModified: 0 })
  const entry = { id: created.descriptor.id, kind: 'file', state: 'ready', descriptor: created.descriptor, envelope: created.envelope }
  const first = await vault.encryptChunk(created.secret, created.descriptor, 0, new Uint8Array(vault.CHUNK_SIZE).fill(7))
  let requests = 0; globalThis.fetch = async () => { requests++; return new Response(first) }
  const controller = new AbortController()
  await assert.rejects(service.readMediaBlob(entry, { signal: controller.signal, onProgress() { controller.abort() } }), { name: 'AbortError' })
  assert.equal(requests, 1)
})

test('public media previews keep recipient credentials and keys out of chunk requests and honor close', async t => {
  const f = await fixture(t, encode('private media fixture'), { name: 'image.png', type: 'image/png' }), shareId = randomUUID()
  const shared = await vault.createShare(f.entry, f.created.opened, shareId)
  const share = { id: shareId, entryId: f.entry.id, ownerId: f.user.id, descriptor: f.entry.descriptor, envelope: shared.envelope }
  const ciphertext = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.data)
  let requests = 0
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.ok(!JSON.stringify(options).includes(shared.keyFragment))
    if (path === '/api/vault/public/open') return json({ share })
    assert.equal(path, '/api/vault/public/' + shareId + '/chunks/0'); assert.equal(options.headers.Authorization, 'Bearer ' + shared.token)
    requests++; return new Response(ciphertext)
  }
  const remote = await client.openPublicVault({ id: shareId, token: shared.token, keyFragment: shared.keyFragment })
  try {
    assert.equal(await (await remote.readMediaBlob()).text(), 'private media fixture')
    remote.close(); await assert.rejects(remote.readMediaBlob(), { name: 'AbortError' }); assert.equal(requests, 1)
  } finally { remote.close() }
})

test('Blob construction failure is reported as local storage failure before another chunk is requested', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 3).fill(19), { name: 'audio.mp3', type: 'audio/mpeg' })
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const service = client.createVaultClient({ user: f.user }); t.after(() => service.close())
  const original = Blob.prototype.slice; t.after(() => { Blob.prototype.slice = original })
  Blob.prototype.slice = function() { return { arrayBuffer: () => Promise.reject(new DOMException('temporary storage unavailable', 'NotReadableError')) } }
  let requests = 0; globalThis.fetch = async () => { requests++; return new Response(first) }
  await assert.rejects(service.readMediaBlob(f.entry), error => error.code === 'VAULT_LOCAL_STORAGE' && /temporary storage/u.test(error.message))
  assert.equal(requests, 1)
})

test('abort during a Blob construction barrier wipes a late probe and stops subsequent chunk requests', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE + 3).fill(11), { name: 'audio.mp3', type: 'audio/mpeg' })
  const first = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data.subarray(0, vault.CHUNK_SIZE))
  const service = client.createVaultClient({ user: f.user }); t.after(() => service.close())
  const original = Blob.prototype.arrayBuffer; t.after(() => { Blob.prototype.arrayBuffer = original })
  let release, requests = 0
  Blob.prototype.arrayBuffer = function() { assert.equal(this.size, 1); return new Promise(resolve => { release = resolve }) }
  globalThis.fetch = async () => { requests++; return new Response(first) }
  const controller = new AbortController(), pending = service.readMediaBlob(f.entry, { signal: controller.signal })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' })
  const late = new Uint8Array([77]); release(late.buffer); await new Promise(resolve => setImmediate(resolve))
  assert.equal(late[0], 0); assert.equal(requests, 1)
})

test('received media uses authenticated recipient access and the account lifetime', async t => {
  const f = await fixture(t, encode('private received media'), { name: 'Shared-video.webm', type: 'video/webm' })
  const encrypted = await vault.encryptChunk(f.created.secret, f.created.descriptor, 0, f.data)
  const window = {}
  runInNewContext(accountScript, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } })
  const prepared = await window.ClubCrypto.prepareRegistration('media-recipient', 'A long recipient media passphrase')
  const user = { id: randomUUID(), username: 'media-recipient', publicKey: prepared.publicKey, identity: prepared.identity }
  await window.ClubCrypto.unlock(user, 'A long recipient media passphrase')
  const shareId = randomUUID(), envelope = await vault.sealMemberShare(f.user, f.entry, f.created.opened, shareId, user)
  globalThis.ClubCrypto = window.ClubCrypto
  const share = { id: shareId, entryId: f.entry.id, ownerId: f.user.id, recipientId: user.id, descriptor: f.entry.descriptor, envelope,
    owner: { id: f.user.id, publicKey: f.user.publicKey } }
  const entry = { ...share, id: share.entryId, receivedShareId: shareId, share, kind: 'file', state: 'ready', parentId: null }
  const account = new AbortController(), service = client.createVaultClient({ user, signal: account.signal }); t.after(() => service.close())
  let requests = 0
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/vault/received/' + shareId + '/chunks/0'); assert.equal(options.credentials, 'same-origin')
    requests++; return new Response(encrypted)
  }
  assert.equal(await (await service.readMediaBlob(entry)).text(), 'private received media')
  await assert.rejects(service.readMediaBlob({ ...entry, share: { ...share, recipientId: randomUUID() } }), /unavailable/u)
  account.abort(); await assert.rejects(service.readMediaBlob(entry), { name: 'AbortError' }); assert.equal(requests, 1)
})
