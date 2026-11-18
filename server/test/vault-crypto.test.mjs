import assert from 'node:assert/strict'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as vault from '../../web/vault-crypto.js'

const accountScript = readFileSync(new URL('../../web/crypto.js', import.meta.url), 'utf8')
const password = 'A long vault test passphrase for the owner'
function storage() {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) }
}
function accountCrypto() {
  const window = {}
  runInNewContext(accountScript, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } })
  return window.ClubCrypto
}
async function account(name = 'vault-owner') {
  const crypto = accountCrypto()
  const prepared = await crypto.prepareRegistration(name, password)
  const user = { id: randomUUID(), username: name, publicKey: prepared.publicKey, identity: prepared.identity }
  assert.equal(await crypto.unlock(user, password), true)
  return { crypto, user }
}
async function fixture(t, bytes = new TextEncoder().encode('A private file that only the endpoints may read.')) {
  vault.clearVaultKeys()
  const owner = await account()
  globalThis.ClubCrypto = owner.crypto
  t.after(() => { vault.clearVaultKeys(); delete globalThis.ClubCrypto })
  const id = randomUUID()
  const file = new File([bytes], 'private-vault-计划.txt', { type: 'text/plain', lastModified: 1720000000000 })
  const created = await vault.createFile(owner.user, id, file)
  const entry = { id, kind: 'file', ownerId: owner.user.id, descriptor: created.descriptor, envelope: created.envelope }
  return { ...owner, file, created, entry, bytes }
}
const shareRow = (entry, owner, id, envelope) => ({ id, entryId: entry.id, ownerId: owner.id, descriptor: entry.descriptor, envelope, owner: { id: owner.id, publicKey: owner.publicKey } })

test('owner headers hide names, MIME and file keys and reopen with the existing account identity', async t => {
  const f = await fixture(t)
  const serialized = JSON.stringify(f.entry.envelope)
  assert.ok(!serialized.includes(f.file.name))
  assert.ok(!serialized.includes('text/plain'))
  assert.equal(JSON.stringify(f.created.secret), '{}')
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  assert.equal(encrypted.byteLength, f.bytes.byteLength + 28)
  assert.ok(!Buffer.from(encrypted).includes(Buffer.from(f.bytes)))
  const opened = await vault.openEntry(f.user, f.entry)
  assert.equal(opened.name, f.file.name)
  assert.equal(opened.type, 'text/plain')
  assert.equal(opened.modifiedAt, f.file.lastModified)
  assert.deepEqual(await vault.decryptChunk(opened.secret, opened.descriptor, 0, encrypted), f.bytes)
})

test('empty files still have one authenticated chunk', async t => {
  const f = await fixture(t, new Uint8Array())
  assert.equal(f.entry.descriptor.chunks, 1)
  assert.equal(f.entry.descriptor.cipherSize, 28)
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  assert.equal(encrypted.byteLength, 28)
  assert.equal((await vault.decryptChunk(f.created.secret, f.entry.descriptor, 0, encrypted)).byteLength, 0)
  await assert.rejects(vault.decryptChunk(f.created.secret, f.entry.descriptor, 0, encrypted.subarray(0, 27)))
})

test('header substitution, descriptor tampering and kind changes are rejected', async t => {
  const f = await fixture(t)
  for (const override of [{ id: randomUUID() }, { ownerId: randomUUID() }, { kind: 'folder', descriptor: null },
    { descriptor: { ...f.entry.descriptor, contentId: Buffer.alloc(32, 9).toString('base64url') } },
    { descriptor: { ...f.entry.descriptor, size: f.bytes.byteLength + 1, cipherSize: f.bytes.byteLength + 29 } }]) {
    await assert.rejects(vault.openEntry(f.user, { ...f.entry, ...override }))
  }
})

test('chunks reject byte changes, truncation, trailing data and reordering', async t => {
  const f = await fixture(t, new Uint8Array(vault.CHUNK_SIZE * 2).fill(84))
  const first = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes.subarray(0, vault.CHUNK_SIZE))
  const second = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 1, f.bytes.subarray(vault.CHUNK_SIZE))
  const tampered = Uint8Array.from(first); tampered[31] ^= 1
  for (const candidate of [tampered, first.subarray(0, first.length - 1), new Uint8Array(first.length + 1), second]) {
    await assert.rejects(vault.decryptChunk(f.created.secret, f.entry.descriptor, 0, candidate))
  }
  await assert.rejects(vault.decryptChunk(f.created.secret, f.entry.descriptor, 2, first))
  const forged = { ...f.entry.descriptor, chunks: 1, size: vault.CHUNK_SIZE, cipherSize: vault.CHUNK_SIZE + 28 }
  await assert.rejects(vault.decryptChunk(f.created.secret, forged, 0, first))
})

test('an upload handle cannot encrypt an index twice and opened entries cannot write chunks', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  await assert.rejects(vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes))
  const opened = await vault.openEntry(f.user, f.entry)
  await assert.rejects(vault.encryptChunk(opened.secret, opened.descriptor, 0, f.bytes))
  assert.deepEqual(await vault.decryptChunk(opened.secret, opened.descriptor, 0, encrypted), f.bytes)
})

test('locking, destruction and cancellation invalidate keys including pending asynchronous work', async t => {
  const f = await fixture(t)
  const pending = vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  vault.clearVaultKeys()
  await assert.rejects(pending, error => error.name === 'AbortError')
  await assert.rejects(vault.decryptChunk(f.created.secret, f.entry.descriptor, 0, new Uint8Array(f.bytes.length + 28)))
  const opened = await vault.openEntry(f.user, f.entry)
  vault.destroySecret(opened.secret)
  await assert.rejects(vault.decryptChunk(opened.secret, opened.descriptor, 0, new Uint8Array(f.bytes.length + 28)))
  const again = await vault.openEntry(f.user, f.entry)
  f.crypto.lock()
  await assert.rejects(vault.decryptChunk(again.secret, again.descriptor, 0, new Uint8Array(f.bytes.length + 28)))
})

test('password rewrapping preserves existing Vault files without exposing another secret to the server', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  const nextPassword = 'A different long vault account passphrase'
  const changed = await f.crypto.rewrapIdentity(f.user, password, nextPassword)
  f.crypto.lock()
  assert.equal(await f.crypto.unlock({ ...f.user, identity: changed.identity }, nextPassword), true)
  const opened = await vault.openEntry(f.user, f.entry)
  assert.deepEqual(await vault.decryptChunk(opened.secret, opened.descriptor, 0, encrypted), f.bytes)
})

test('member shares reopen for owner and selected recipient, not unrelated members', async t => {
  const f = await fixture(t)
  const recipient = await account('vault-recipient')
  const unrelated = await account('vault-unrelated')
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  const id = randomUUID()
  const envelope = await vault.sealMemberShare(f.user, f.entry, f.created.opened, id, recipient.user)
  const share = shareRow(f.entry, f.user, id, envelope)
  assert.equal((await vault.openMemberShare(f.user, share)).name, f.file.name)
  globalThis.ClubCrypto = recipient.crypto
  const opened = await vault.openMemberShare(recipient.user, share)
  assert.deepEqual(await vault.decryptChunk(opened.secret, opened.descriptor, 0, encrypted), f.bytes)
  await assert.rejects(vault.openEntry(recipient.user, f.entry))
  await assert.rejects(vault.openMemberShare(recipient.user, { ...share, entryId: randomUUID() }))
  await assert.rejects(vault.openMemberShare(recipient.user, { ...share, id: randomUUID() }))
  globalThis.ClubCrypto = unrelated.crypto
  await assert.rejects(vault.openMemberShare(unrelated.user, share))
})

test('public shares require a separate decryption key and bind share, entry, owner and descriptor', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  const id = randomUUID()
  const created = await vault.createShare(f.entry, f.created.opened, id)
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/)
  assert.match(created.keyFragment, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(created.token, created.keyFragment)
  assert.equal(created.tokenHash, createHash('sha256').update(created.token).digest('base64url'))
  assert.ok(!JSON.stringify(created.envelope).includes(f.file.name))
  const share = shareRow(f.entry, f.user, id, created.envelope)
  const opened = await vault.openShare(share, created.keyFragment)
  assert.deepEqual(await vault.decryptChunk(opened.secret, opened.descriptor, 0, encrypted), f.bytes)
  await assert.rejects(vault.openShare(share, created.token))
  for (const change of [{ id: randomUUID() }, { entryId: randomUUID() }, { ownerId: randomUUID() },
    { descriptor: { ...share.descriptor, contentId: Buffer.alloc(32, 8).toString('base64url') } }]) {
    await assert.rejects(vault.openShare({ ...share, ...change }, created.keyFragment))
  }
  const tampered = { ...share, envelope: { ...share.envelope, body: share.envelope.body.slice(0, -2) + 'AA' } }
  await assert.rejects(vault.openShare(tampered, created.keyFragment))
})

test('rename updates only authenticated owner metadata; an existing share retains its encrypted snapshot', async t => {
  const f = await fixture(t)
  const encrypted = await vault.encryptChunk(f.created.secret, f.entry.descriptor, 0, f.bytes)
  const id = randomUUID()
  const share = await vault.createShare(f.entry, f.created.opened, id)
  const envelope = await vault.renameEntry(f.user, f.entry, f.created.opened, 'renamed-文件.txt')
  const renamed = await vault.openEntry(f.user, { ...f.entry, envelope })
  assert.equal(renamed.name, 'renamed-文件.txt')
  assert.deepEqual(await vault.decryptChunk(renamed.secret, renamed.descriptor, 0, encrypted), f.bytes)
  assert.equal((await vault.openShare(shareRow(f.entry, f.user, id, share.envelope), share.keyFragment)).name, f.file.name)
})

test('folder names are encrypted and path/control spoofing is rejected', async t => {
  const f = await fixture(t)
  const id = randomUUID()
  const created = await vault.createFolder(f.user, id, 'Meine 私人文件')
  assert.ok(!JSON.stringify(created.envelope).includes('Meine 私人文件'))
  const entry = { id, kind: 'folder', descriptor: null, envelope: created.envelope }
  assert.equal((await vault.openEntry(f.user, entry)).name, 'Meine 私人文件')
  for (const value of ['.', '..', '../escape', 'a/b', 'a\\b', '\u0000hidden', 'a\u202Etxt', 'a\u0085b', 'a\u009fb', 'x'.repeat(256), '中'.repeat(86)]) {
    assert.throws(() => vault.validateName(value))
  }
  assert.equal(vault.validateName('中'.repeat(85)), '中'.repeat(85))
})

test('optional saved public links stay owner-encrypted and reject swapped share IDs', async t => {
  const f = await fixture(t)
  const id = randomUUID()
  const shared = await vault.createShare(f.entry, f.created.opened, id)
  const ownerEnvelope = await vault.sealShareLink(f.user, f.entry.id, id, shared)
  assert.ok(!JSON.stringify(ownerEnvelope).includes(shared.keyFragment))
  assert.ok(!JSON.stringify(ownerEnvelope).includes(shared.token))
  const share = { id, entryId: f.entry.id, ownerEnvelope }
  assert.deepEqual(await vault.openShareLink(f.user, share), { token: shared.token, keyFragment: shared.keyFragment })
  await assert.rejects(vault.openShareLink(f.user, { ...share, id: randomUUID() }))
})

test('multi-gigabyte uploads are read a chunk at a time and cancellation stops further reads', async t => {
  const f = await fixture(t)
  const slices = []
  const file = { name: 'large.bin', type: '', size: 2 * 1024 ** 3, lastModified: 0,
    arrayBuffer() { throw new Error('Whole-file reads are forbidden') },
    slice(start, end) { slices.push([start, end]); return new Blob([new Uint8Array(end - start)]) } }
  const created = await vault.createFile(f.user, randomUUID(), file)
  assert.equal(created.descriptor.chunks, 512)
  const controller = new AbortController()
  const stream = vault.encryptChunks(file, created.secret, created.descriptor, { signal: controller.signal })
  const first = await stream.next()
  assert.equal(first.value.ciphertext.length, vault.CHUNK_SIZE + 28)
  assert.deepEqual(slices, [[0, vault.CHUNK_SIZE]])
  controller.abort()
  await assert.rejects(stream.next(), error => error.name === 'AbortError')
  assert.equal(slices.length, 1)
})

test('untrusted descriptors and noncanonical capability encodings fail before crypto work', async t => {
  const f = await fixture(t)
  for (const change of [{ size: -1 }, { size: Number.MAX_SAFE_INTEGER }, { chunks: 0 }, { chunkSize: 8 }, { cipherSize: 1 },
    { id: '../escape' }, { contentId: 'x'.repeat(43) }]) {
    assert.throws(() => vault.validateDescriptor({ ...f.entry.descriptor, ...change }))
  }
  await assert.rejects(vault.capabilityHash('A'.repeat(42) + 'B'))
  await assert.rejects(vault.createFile(f.user, randomUUID(), { name: 'too-large', type: '', size: vault.MAX_FILE_SIZE + 1 }))
})

test('Vault rejects replacement headers fabricated with only public account keys', async t => {
  const f = await fixture(t)
  const recipient = await account('recipient-header-auth')
  const attacker = await account('server-header-forgery')
  const value = { v: 1, ownerId: f.user.id, id: f.entry.id, kind: 'file', name: 'forged.txt',
    mime: 'text/plain', modifiedAt: 0, descriptor: f.entry.descriptor, key: Buffer.alloc(32, 7).toString('base64url') }
  const ownerScope = `zelotez-vault/1/owner/${f.user.id}`
  const ownerForgery = (await attacker.crypto.sealMessage(ownerScope, f.entry.id, value,
    [{ id: attacker.user.id, publicKey: attacker.user.publicKey }, { id: f.user.id, publicKey: f.user.publicKey }])).envelope
  delete ownerForgery.keys[attacker.user.id]
  assert.equal((await f.crypto.openMessage(ownerScope, f.entry.id, ownerForgery)).content.name, 'forged.txt')
  await assert.rejects(vault.openEntry(f.user, { ...f.entry, envelope: ownerForgery }))

  const shareId = randomUUID()
  const memberScope = `zelotez-vault/1/member/${f.user.id}/${f.entry.id}`
  const memberForgery = (await attacker.crypto.sealMessage(memberScope, shareId, { ...value, shareId },
    [{ id: attacker.user.id, publicKey: attacker.user.publicKey }, { id: f.user.id, publicKey: f.user.publicKey },
      { id: recipient.user.id, publicKey: recipient.user.publicKey }])).envelope
  delete memberForgery.keys[attacker.user.id]
  globalThis.ClubCrypto = recipient.crypto
  assert.equal((await recipient.crypto.openMessage(memberScope, shareId, memberForgery)).content.name, 'forged.txt')
  await assert.rejects(vault.openMemberShare(recipient.user, shareRow(f.entry, f.user, shareId, memberForgery)))
})

test('Vault never accepts chat history grants as a substitute for authenticated sender boxes', async t => {
  const f = await fixture(t)
  const attacker = await account('history-grant-forgery')
  const scope = `zelotez-vault/1/owner/${f.user.id}`
  const value = { v: 1, ownerId: f.user.id, id: f.entry.id, kind: 'file', name: 'forged-history.txt',
    mime: 'text/plain', modifiedAt: 0, descriptor: f.entry.descriptor, key: Buffer.alloc(32, 8).toString('base64url') }
  const attackerEnvelope = (await attacker.crypto.sealMessage(scope, f.entry.id, value,
    [{ id: attacker.user.id, publicKey: attacker.user.publicKey }])).envelope
  const grant = await attacker.crypto.wrapHistoryKey(scope, { id: f.entry.id,
    ephemeral: attackerEnvelope.ephemeral, ...attackerEnvelope.keys[attacker.user.id],
    messageNonce: attackerEnvelope.nonce, messageBody: attackerEnvelope.body }, f.user)
  const forged = { ...attackerEnvelope, ephemeral: f.user.publicKey, keys: {},
    historyGrant: { ...grant, grantorId: attacker.user.id } }
  assert.equal((await f.crypto.openMessage(scope, f.entry.id, forged)).content.name, 'forged-history.txt')
  await assert.rejects(vault.openEntry(f.user, { ...f.entry, envelope: forged }))
  // Even a redundant grant on a genuine original header is outside the Vault format.
  await assert.rejects(vault.openEntry(f.user, { ...f.entry, envelope: { ...f.entry.envelope, historyGrant: null } }))
})

test('a fresh nested owner cannot bypass an already pinned share sender', async t => {
  const f = await fixture(t)
  const recipient = await account('recipient-owner-binding')
  const attacker = await account('unrelated-owner-binding')
  const shareId = randomUUID()
  const legitimate = await vault.sealMemberShare(f.user, f.entry, f.created.opened, shareId, recipient.user)
  globalThis.ClubCrypto = recipient.crypto
  await vault.openMemberShare(recipient.user, shareRow(f.entry, f.user, shareId, legitimate))
  const scope = `zelotez-vault/1/member/${f.user.id}/${f.entry.id}`
  const value = { v: 1, ownerId: f.user.id, id: f.entry.id, shareId, kind: 'file', name: 'forged-owner.txt',
    mime: 'text/plain', modifiedAt: 0, descriptor: f.entry.descriptor, key: Buffer.alloc(32, 9).toString('base64url') }
  const envelope = (await attacker.crypto.sealMessage(scope, shareId, value,
    [{ id: attacker.user.id, publicKey: attacker.user.publicKey }, { id: recipient.user.id, publicKey: recipient.user.publicKey }])).envelope
  delete envelope.keys[attacker.user.id]
  assert.equal((await recipient.crypto.openMessage(scope, shareId, envelope)).content.name, 'forged-owner.txt')
  const forged = { ...shareRow(f.entry, f.user, shareId, envelope),
    owner: { id: attacker.user.id, publicKey: envelope.ephemeral } }
  await assert.rejects(vault.openMemberShare(recipient.user, forged))
  await assert.rejects(recipient.crypto.openVaultMessage(scope, shareId, envelope, forged.owner))
  await assert.rejects(attacker.crypto.sealVaultMessage(scope, shareId, value,
    [{ id: attacker.user.id, publicKey: attacker.user.publicKey }, { id: recipient.user.id, publicKey: recipient.user.publicKey }]))
})
