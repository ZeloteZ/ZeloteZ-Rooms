import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { createQuickChat } from '../quick-chat.mjs'
import { createQuickChatCrypto } from '../../web/quick-chat-crypto.js'

const data = size => randomBytes(size).toString('base64url')
const wrap = () => ({ nonce: data(12), blob: data(48) })
const encrypted = peers => ({ nonce: data(12), blob: data(40), keys: Object.fromEntries(peers.map(peer => [peer.id, wrap()])) })

function fixture(t) {
  const active = new Map()
  let time = Date.now()
  const chat = createQuickChat({ now: () => time, isGuestActive: (key, roomId) => active.get(key.token ?? key.session) === roomId })
  t.after(chat.close)

  function viewer(roomId = randomUUID(), guest = false, name = 'Room member') {
    const guestKey = guest ? { token: data(32) } : { userId: randomUUID(), session: data(32) }
    active.set(guestKey.token ?? guestKey.session, roomId)
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
    return { id: randomUUID(), publicKey, scope: { roomId, guestKey, ...(guest ? {} : { displayName: name }) }, revoke() {
      active.delete(guestKey.token ?? guestKey.session)
    } }
  }

  async function request(actor, method, action, body, params = '') {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.headers = body === undefined ? {} : { 'content-type': 'application/json' }
    const chunks = []
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
    res.writeHead = status => { res.status = status }
    const path = `/api/guest/${actor.scope.roomId}/chat${action === 'chat' ? '' : '/' + action}${params}`
    await chat.handle(req, res, actor.scope, action, new URL(path, 'http://127.0.0.1'))
    return { status: res.status, body: JSON.parse(Buffer.concat(chunks)) }
  }

  const join = actor => request(actor, 'POST', 'join', { deviceId: actor.id, publicKey: actor.publicKey })
  const read = (actor, after = 0, id = actor.id) => request(actor, 'GET', 'chat', undefined, `?deviceId=${id}&after=${after}`)
  const send = (actor, envelope, id = randomUUID()) => request(actor, 'POST', 'chat', { deviceId: actor.id, id, envelope })
  const tick = ms => { time += ms; chat.sweep() }
  return { chat, viewer, request, join, read, send, tick }
}

test('temporary live chat delivers only the authorized device wrap and binds sender identity', async t => {
  const { viewer, request, join, read, send } = fixture(t)
  const owner = viewer(randomUUID(), false, 'Signed-in friend')
  const guest = viewer(owner.scope.roomId, true)
  const unrelated = viewer()
  await join(owner)
  const result = (await join(guest)).body
  const guestRosterEntry = result.peers.find(peer => peer.id === guest.id)
  assert.equal(guestRosterEntry.guest, true)
  assert.match(guestRosterEntry.name, /^[0-9A-F]{6}$/u)
  assert.deepEqual(guestRosterEntry.publicKey, guest.publicKey)
  assert.deepEqual(result.messages, [])
  await join(unrelated)
  await assert.rejects(read(unrelated, 0, owner.id), { status: 409 })
  await assert.rejects(read(guest, 0, owner.id), { status: 409 })
  await assert.rejects(request(guest, 'POST', 'chat', { deviceId: owner.id, id: randomUUID(), envelope: encrypted([owner, guest]) }), { status: 409 })
  await assert.rejects(send(owner, encrypted([owner])), { status: 409 })
  await assert.rejects(send(owner, encrypted([owner, guest, unrelated])), { status: 409 })
  await assert.rejects(send(owner, { ...encrypted([owner, guest]), text: 'plaintext' }), { status: 400 })
  await assert.rejects(send(owner, encrypted([owner, guest]), [randomUUID()]), { status: 400 })

  const encryptedMessage = encrypted([owner, guest])
  const messageId = randomUUID()
  const { status, body: sent } = await send(owner, encryptedMessage, messageId)
  assert.equal(status, 201)
  assert.equal(sent.cursor, 1)
  assert.deepEqual(sent.messages[0].envelope.key, encryptedMessage.keys[owner.id])
  const { deviceId, messages, cursor } = (await read(guest)).body
  assert.equal(deviceId, guest.id)
  assert.equal(cursor, 1)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], { id: messageId, from: owner.id, own: false, guest: false, name: 'Signed-in friend',
    sentAt: messages[0].sentAt, publicKey: owner.publicKey,
    envelope: { nonce: encryptedMessage.nonce, blob: encryptedMessage.blob, key: encryptedMessage.keys[guest.id] } })
  assert.deepEqual((await read(guest, cursor)).body.messages, [])
  assert.deepEqual((await read(unrelated)).body.messages, [])
  assert.equal((await send(owner, encryptedMessage, messageId)).body.cursor, 1)
  await assert.rejects(send(guest, encrypted([owner, guest]), messageId), { status: 409 })
})

test('participant names deduplicate an account or guest ticket while keeping each device for encryption', async t => {
  const { viewer, join, read, request, send } = fixture(t)
  const owner = viewer()
  const sameName = viewer(owner.scope.roomId)
  const otherSession = viewer(owner.scope.roomId)
  otherSession.scope.guestKey.userId = owner.scope.guestKey.userId
  const guest = viewer(owner.scope.roomId, true)
  const guestTab = { ...guest, id: randomUUID() }
  for (const peer of [owner, sameName, otherSession, guest]) await join(peer)
  const { body: { peers, participants } } = await join(guestTab)
  const [guestName] = participants.filter(person => person.guest).map(person => person.name)
  assert.match(guestName, /^[0-9A-F]{6}$/u)
  assert.deepEqual(participants, [{ name: 'Room member', guest: false }, { name: 'Room member', guest: false },
    { name: guestName, guest: true }])
  assert.equal(peers.length, 5)
  assert.equal((await send(guestTab, encrypted(peers))).body.messages[0].name, guestName)

  await request(guestTab, 'POST', 'leave', { deviceId: guestTab.id })
  assert.equal((await read(owner)).body.participants.length, 3)
  await request(guest, 'POST', 'leave', { deviceId: guest.id })
  assert.equal((await read(owner)).body.participants.length, 2)
})

test('browser chat keys encrypt messages for each current device', async t => {
  const { viewer, join, read, send } = fixture(t)
  const roomId = randomUUID()
  const [hostKeys, guestKeys, outsideKeys] = await Promise.all(Array.from({ length: 3 }, () => createQuickChatCrypto(roomId)))
  const owner = { ...viewer(roomId), id: hostKeys.deviceId, publicKey: hostKeys.publicKey }
  const guest = { ...viewer(roomId, true), id: guestKeys.deviceId, publicKey: guestKeys.publicKey }
  await join(owner)
  const { body: { peers } } = await join(guest)
  const id = randomUUID()
  const content = 'Eine verschlüsselte Nachricht 🔐'
  const envelope = await hostKeys.seal(id, content, peers)
  const sent = (await send(owner, envelope, id)).body.messages[0]
  const received = (await read(guest)).body.messages[0]
  assert.equal(sent.envelope.blob, received.envelope.blob)
  assert.ok(!JSON.stringify(received).includes(content))
  assert.equal(await hostKeys.open(sent), content)
  assert.equal(await guestKeys.open(received), content)
  await assert.rejects(outsideKeys.open(received))
  await assert.rejects(guestKeys.open({ ...received, id: randomUUID() }))
})

test('temporary chat encrypts quote references without copying the original text', async t => {
  const { viewer, join, read, send } = fixture(t)
  const roomId = randomUUID()
  const [hostKeys, guestKeys] = await Promise.all([createQuickChatCrypto(roomId), createQuickChatCrypto(roomId)])
  const host = { ...viewer(roomId), id: hostKeys.deviceId, publicKey: hostKeys.publicKey }
  const guest = { ...viewer(roomId, true), id: guestKeys.deviceId, publicKey: guestKeys.publicKey }
  await join(host)
  const { peers } = (await join(guest)).body
  const original = randomUUID()
  await send(host, await hostKeys.seal(original, 'Original message', peers), original)
  const id = randomUUID()
  const reply = await guestKeys.seal(id, 'My reply', peers, original)
  await assert.rejects(send(guest, { ...reply, reply: { nonce: data(12), blob: data(53) } }, id), { status: 400 })
  const posted = (await send(guest, reply, id)).body.messages[0]
  assert.equal(posted.own, true)
  const received = (await read(host, 1)).body.messages[0]
  assert.equal(received.own, false)
  assert.ok(!JSON.stringify(received).includes(original))
  assert.equal(await hostKeys.open(received), 'My reply')
  assert.deepEqual(await hostKeys.open(received, { includeReply: true }), { text: 'My reply', replyTo: original })
  const unrelated = await guestKeys.seal(randomUUID(), 'Unrelated reply', peers, original)
  received.envelope.reply = unrelated.reply
  assert.deepEqual(await hostKeys.open(received, { includeReply: true }), { text: 'My reply', replyTo: undefined })
})

test('revoked credentials cannot access chat and replacement devices only see later messages', async t => {
  const { viewer, request, join, read, send, tick } = fixture(t)
  const owner = viewer()
  const guest = viewer(owner.scope.roomId, true)
  await join(owner)
  await join(guest)
  await send(guest, encrypted([owner, guest]))
  guest.revoke()
  await assert.rejects(read(guest), { status: 401 })
  await assert.rejects(join(guest), { status: 401 })
  await assert.rejects(send(guest, encrypted([owner, guest])), { status: 401 })
  await assert.rejects(send(owner, encrypted([owner, guest])), { status: 409 })
  const replacement = viewer(owner.scope.roomId, true)
  const result = (await join(replacement)).body
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.peers.map(peer => peer.id), [owner.id, replacement.id])
  // The previous sender can leave without invalidating messages an existing device can already read.
  assert.deepEqual((await read(owner)).body.messages[0].publicKey, guest.publicKey)
  assert.deepEqual((await read(replacement, 0)).body.messages, [])
  tick(120_001)
  assert.equal((await read(owner)).body.messages.length, 1)
  assert.equal((await join(owner)).body.messages.length, 1)
  await assert.rejects(request(owner, 'GET', 'chat', undefined, `?deviceId=${owner.id}&deviceId=${owner.id}`), { status: 400 })
})

test('the same device can decrypt the recent chat after leaving and rejoining', async t => {
  const { viewer, join, request, read, send, tick } = fixture(t)
  const roomId = randomUUID()
  const [hostKeys, guestKeys] = await Promise.all([createQuickChatCrypto(roomId), createQuickChatCrypto(roomId)])
  const host = { ...viewer(roomId), id: hostKeys.deviceId, publicKey: hostKeys.publicKey }
  const guest = { ...viewer(roomId, true), id: guestKeys.deviceId, publicKey: guestKeys.publicKey }
  await join(host)
  await join(guest)
  const first = randomUUID()
  await send(host, await hostKeys.seal(first, 'before leaving', (await read(host)).body.peers), first)
  await request(guest, 'POST', 'leave', { deviceId: guest.id })
  tick(120_001)
  const { peers, participants } = (await read(host)).body
  assert.equal(participants.length, 1)
  const second = randomUUID()
  await send(host, await hostKeys.seal(second, 'while away', peers), second)
  const returned = (await join(guest)).body
  assert.equal(returned.participants.length, 2)
  assert.deepEqual(await Promise.all(returned.messages.map(guestKeys.open)), ['before leaving', 'while away'])
  assert.deepEqual((await join(viewer(roomId, true))).body.messages, [])
})

test('registration validates keys and bounds devices and send rate', async t => {
  const { viewer, request, join, send, tick } = fixture(t)
  const device = viewer()
  await assert.rejects(request(device, 'POST', 'join', { deviceId: [device.id], publicKey: device.publicKey }), { status: 400 })
  await assert.rejects(request(device, 'POST', 'join', { deviceId: device.id, publicKey: { ...device.publicKey, crv: 'P-384' } }), { status: 400 })
  await assert.rejects(request(device, 'POST', 'join', { deviceId: device.id, publicKey: { ...device.publicKey, d: data(32) } }), { status: 400 })
  await assert.rejects(request(device, 'POST', 'join', { deviceId: device.id, publicKey: { ...device.publicKey,
    x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') } }), { status: 400 })
  await join(device)
  for (let index = 0; index < 5; index++) await send(device, encrypted([device]))
  await assert.rejects(send(device, encrypted([device])), { status: 429 })
  tick(5001)
  assert.equal((await send(device, encrypted([device]))).body.cursor, 6)
  const additional = Array.from({ length: 4 }, () => ({ ...device, id: randomUUID() }))
  for (const peer of additional.slice(0, 3)) await join(peer)
  await assert.rejects(join(additional[3]), { status: 429 })
  const other = viewer(device.scope.roomId, true)
  assert.deepEqual((await request(other, 'POST', 'leave', { deviceId: device.id })).body, { ok: true })
  await assert.rejects(join(additional[3]), { status: 429 })
  assert.deepEqual((await request(device, 'POST', 'leave', { deviceId: device.id })).body, { ok: true })
  await join(additional[3])
})
