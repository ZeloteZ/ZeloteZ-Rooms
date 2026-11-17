import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAuth } from '../auth.mjs'
import { createCommunity } from '../community.mjs'
import { RequestError } from '../http.mjs'
import { createQuickRooms } from '../quick-rooms.mjs'

const origin = 'https://rooms.example.com'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const auth = createAuth(db, { publicOrigin: origin })
  db.exec('CREATE TABLE topic_designers (topic_id TEXT, user_id TEXT)')
  const appearance = { topic: () => ({}), profile: () => ({}), designPermission: () => false }
  const community = createCommunity(db, { requireSession: auth.requireSession, appearance })
  db.exec('CREATE TABLE broadcasts(id TEXT, channel_id TEXT, ended_at INTEGER) STRICT')
  const current = new Map()
  const viewerReports = []
  let time = Date.now()
  const media = { hasGuestSource: id => current.has(id), guestSnapshot: ({ channelId }) => ({
    serverTime: time, party: current.get(channelId),
  }), controlGuestPlayback: ({ channelId }, { partyId, revision, action, position }) => {
    const party = current.get(channelId)
    if (party?.id !== partyId) throw new RequestError(404)
    if (party.revision !== revision) throw new RequestError(409)
    current.set(channelId, { ...party, revision: revision + 1, position: position ?? party.position, playing: action === 'play' })
  }, reportGuestViewer(scope, { partyId, playerId }, method, isActive) {
    if (current.get(scope.channelId)?.id !== partyId || !isActive()) throw new RequestError(404)
    viewerReports.push({ roomId: scope.roomId, playerId, method, guest: Boolean(scope.guestKey.token) })
  } }
  const quick = createQuickRooms(db, { publicOrigin: origin, auth, community, streams: media, watchParties: media,
    now: () => time })
  t.after(() => {
    quick.close()
    community.close()
    db.close()
  })

  function user(username) {
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const token = createHash('sha256').update(secret).digest()
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(id, username, username, '', 0, '{}', '{}', new Date(time).toISOString())
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, id, Math.floor(time / 1000) + 7200)
    return { id, cookie: `__Host-zelotez_session=${secret}`,
      revoke: () => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(token) }
  }

  async function request(method, path, { user: actor, cookie = actor?.cookie, body, beforeBody, address = '127.0.0.1' } = {}) {
    const stream = Readable.from((async function* () {
      await beforeBody?.()
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    })())
    stream.method = method
    stream.url = path
    stream.headers = { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) }
    stream.socket = { remoteAddress: address }
    const chunks = []
    const response = new Writable({ write(data, _encoding, done) { chunks.push(data); done() } })
    response.writeHead = (statusCode, headers) => {
      response.statusCode = statusCode
      response.headers = headers
      return response
    }
    const url = new URL(path, origin)
    const handler = url.pathname.startsWith('/api/guest/') ? () => quick.handleGuest(stream, response, url.pathname) :
      url.pathname.startsWith('/api/quick-rooms') ? () => quick.handle(stream, response, url.pathname) :
        () => community.handle(stream, response, url)
    assert.equal(await handler(), true)
    return { status: response.statusCode, headers: response.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined }
  }

  function start(room, owner) {
    quick.assertTemporarySource(room.channelId, owner.id, room.source)
    current.set(room.channelId, { id: randomUUID(), title: 'Shared clip', source: room.source, position: 0, playing: false, revision: 1 })
    quick.noteTemporarySource(room.channelId, owner.id)
  }

  const guestPath = (room, action) => `/api/guest/${room.publicId}/${action}`
  const ownerPath = room => `/api/quick-rooms/${room.publicId}`
  return { db, user, request, quick, start, guestPath, ownerPath, viewerReports,
    stop: room => current.delete(room.channelId), tick: milliseconds => { time += milliseconds } }
}

test('temporary rooms are hidden, use the selected source once, and opt in to signed-in viewer access independently', async t => {
  const { db, user, request, quick, start, stop, tick, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const friend = user('test-friend')
  const ordinary = (await request('POST', '/api/topics', { user: host, body: { title: 'Ordinary', visibility: 'public' } })).body.topic
  const room = (await request('POST', '/api/quick-rooms', { user: host, body: { source: 'youtube' } })).body
  assert.equal(room.guestAccess, false)
  assert.equal(room.memberVisibility, false)
  assert.equal(room.secret, undefined)
  assert.deepEqual((await request('GET', '/api/topics', { user: host })).body.topics.map(topic => topic.id), [ordinary.id])
  assert.deepEqual((await request('GET', '/api/quick-rooms/destinations', { user: host })).body.channels.map(channel => channel.topicId), [ordinary.id])
  const roomPath = '/api/topics/' + room.topicId
  assert.equal((await request('GET', roomPath, { user: host })).body.topic.temporary, true)
  await assert.rejects(request('GET', roomPath, { user: friend }), { status: 404 })
  await assert.rejects(request('PATCH', roomPath, { user: host, body: { visibility: 'public' } }), { status: 403 })
  await assert.rejects(request('GET', guestPath(room, 'state'), { user: friend }), { status: 404 })
  await assert.rejects(request('GET', guestPath(room, 'state')), { status: 404 })
  assert.throws(() => quick.assertTemporarySource(room.channelId, host.id, 'screen'), { status: 409 })
  start(room, host)
  assert.throws(() => quick.assertTemporarySource(room.channelId, host.id, 'youtube'), { status: 409 })
  assert.deepEqual(await quick.homeActivity(), [])
  await assert.rejects(request('PATCH', ownerPath(room), { user: friend, body: { memberVisibility: true } }), { status: 404 })
  await request('PATCH', ownerPath(room), { user: host, body: { memberVisibility: true } })
  assert.deepEqual(await quick.homeActivity(), [{ publicId: room.publicId, source: 'youtube', title: 'Shared clip' }])
  assert.equal((await request('GET', guestPath(room, 'state'), { user: friend })).body.party.title, 'Shared clip')
  await assert.rejects(request('GET', guestPath(room, 'state')), { status: 404 })
  stop(room)
  await assert.rejects(request('GET', guestPath(room, 'state'), { user: friend }), { status: 404 })
  assert.deepEqual(await quick.homeActivity(), [])
  const abandoned = (await request('POST', '/api/quick-rooms', { user: host, body: { source: 'screen' } })).body
  assert.equal(db.prepare('SELECT 1 FROM topics WHERE id = ?').get(room.topicId), undefined)
  assert.equal(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(room.channelId), undefined)
  tick(5 * 60_000 + 1)
  await assert.rejects(request('GET', ownerPath(abandoned), { user: host }), { status: 404 })
  await request('POST', '/api/quick-rooms', { user: host, body: { source: 'screen' } })
  assert.equal(db.prepare('SELECT 1 FROM topics WHERE id = ?').get(abandoned.topicId), undefined)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('a room created for guests and members returns its initial guest secret only on creation', async t => {
  const { user, request, quick, start, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const member = user('test-member')
  const body = { source: 'youtube', guestAccess: true, memberVisibility: true }
  await assert.rejects(request('POST', '/api/quick-rooms', { body }), { status: 401 })
  const { status, body: room } = await request('POST', '/api/quick-rooms', { user: host, body })
  assert.equal(status, 201)
  assert.equal(room.guestAccess, true)
  assert.equal(room.memberVisibility, true)
  assert.equal(room.guestPath, '/guest/' + room.publicId)
  assert.match(room.secret, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal((await request('GET', '/api/quick-rooms', { user: host })).body.room.secret, undefined)
  assert.equal((await request('GET', ownerPath(room), { user: host })).body.secret, undefined)
  const save = await request('PATCH', ownerPath(room), { user: host, body: { guestAccess: true, memberVisibility: true } })
  assert.equal(save.body.secret, undefined)

  assert.deepEqual(await quick.homeActivity(), [])
  start(room, host)
  assert.deepEqual(await quick.homeActivity(), [{ publicId: room.publicId, source: 'youtube', title: 'Shared clip' }])
  await assert.rejects(request('GET', ownerPath(room), { user: member }), { status: 404 })
  await assert.rejects(request('GET', guestPath(room, 'state')), { status: 401 })
  const signedIn = await request('GET', guestPath(room, 'state'), { user: member })
  assert.equal(signedIn.body.party.title, 'Shared clip')
  assert.equal(signedIn.body.secret, undefined)

  const redeem = await request('POST', guestPath(room, 'session'), { body: { password: room.secret } })
  assert.equal(redeem.status, 204)
  const cookie = redeem.headers['Set-Cookie'].split(';')[0]
  const guest = await request('GET', guestPath(room, 'state'), { cookie })
  assert.equal(guest.body.party.title, 'Shared clip')
  assert.equal(guest.body.secret, undefined)
})

test('guest passwords are hashed and redeem only scoped room access, which rotation and revocation invalidate', async t => {
  const { db, user, request, start, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const otherHost = user('test-other-host')
  const create = actor => request('POST', '/api/quick-rooms', { user: actor, body: { source: 'local', guestAccess: true } }).then(result => result.body)
  const room = await create(host)
  const otherRoom = await create(otherHost)
  assert.match(room.secret, /^[A-Za-z0-9_-]{43}$/u)
  assert.deepEqual(Buffer.from(db.prepare('SELECT guest_hash FROM quick_rooms WHERE topic_id = ?').get(room.topicId).guest_hash),
    createHash('sha256').update(room.secret).digest())
  assert.equal((await request('GET', ownerPath(room), { user: host })).body.secret, undefined)
  const redeem = (room, password = room.secret) => request('POST', guestPath(room, 'session'), { body: { password } })
  await assert.rejects(redeem(room, otherRoom.secret), { status: 401 })
  const exchange = await redeem(room)
  assert.equal(exchange.status, 204)
  const header = exchange.headers['Set-Cookie']
  assert.match(header, /^__Secure-zelotez_guest=/u)
  assert.ok(header.includes(`Path=/api/guest/${room.publicId}/; HttpOnly; SameSite=Strict`))
  assert.ok(header.endsWith('; Secure'))
  const cookie = header.split(';')[0]
  const repeated = await request('POST', guestPath(room, 'session'), { cookie, body: { password: room.secret } })
  assert.equal(repeated.status, 204)
  assert.equal(repeated.headers?.['Set-Cookie'], undefined)
  await assert.rejects(request('POST', guestPath(room, 'session'), { cookie, body: { password: otherRoom.secret } }), { status: 401 })
  assert.equal((await request('GET', guestPath(room, 'state'), { cookie })).body.party, null)
  start(room, host)
  assert.equal((await request('GET', guestPath(room, 'state'), { cookie })).body.party.title, 'Shared clip')
  await assert.rejects(request('GET', guestPath(otherRoom, 'state'), { cookie }), { status: 401 })
  await assert.rejects(request('GET', '/api/topics/' + room.topicId, { cookie }), { status: 401 })
  const rotated = (await request('PATCH', ownerPath(room), { user: host, body: { renewPassword: true } })).body
  assert.notEqual(rotated.secret, room.secret)
  await assert.rejects(request('GET', guestPath(room, 'state'), { cookie }), { status: 401 })
  await assert.rejects(redeem(room), { status: 401 })
  const replacement = (await redeem(rotated)).headers['Set-Cookie'].split(';')[0]
  host.revoke()
  await assert.rejects(request('GET', guestPath(room, 'state'), { cookie: replacement }), { status: 404 })
})

test('temporary playback controls require current guest or opted-in account access for each request', async t => {
  const { user, request, start, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const member = user('test-friend')
  const screenHost = user('test-screen-host')
  const create = (actor, source) => request('POST', '/api/quick-rooms', { user: actor, body: { source, guestAccess: true } })
    .then(result => result.body)
  const room = await create(host, 'youtube')
  const screen = await create(screenHost, 'screen')
  start(room, host)
  const exchange = await request('POST', guestPath(room, 'session'), { body: { password: room.secret } })
  const cookie = exchange.headers['Set-Cookie'].split(';')[0]
  const { party } = (await request('GET', guestPath(room, 'state'), { cookie })).body
  const path = guestPath(room, 'playback')
  const body = { partyId: party.id, action: 'play', revision: 1 }
  await assert.rejects(request('GET', path, { cookie }), { status: 405 })
  await assert.rejects(request('PATCH', path, { body }), { status: 401 })
  await assert.rejects(request('PATCH', path, { user: member, body }), { status: 401 })
  await assert.rejects(request('PATCH', guestPath(screen, 'playback'), { user: screenHost, body }), { status: 404 })
  const { body: updated } = await request('PATCH', path, { cookie, body })
  assert.equal(updated.party.playing, true)
  assert.equal(updated.party.revision, 2)
  assert.deepEqual(updated, (await request('GET', guestPath(room, 'state'), { user: host })).body)
  await request('PATCH', ownerPath(room), { user: host, body: { memberVisibility: true } })
  await assert.rejects(request('PATCH', path, { user: member, body }), { status: 409 })
  const pause = { ...body, action: 'pause', revision: 2 }
  await assert.rejects(request('PATCH', path, { cookie, body: pause, beforeBody: () =>
    request('PATCH', ownerPath(room), { user: host, body: { renewPassword: true } }) }), { status: 401 })
  assert.equal((await request('GET', guestPath(room, 'state'), { user: member })).body.party.revision, 2)
  const race = await Promise.allSettled([member, host].map(user => request('PATCH', path, { user, body: pause })))
  assert.deepEqual(race.map(result => result.status === 'fulfilled' ? result.value.status : result.reason.status).sort(), [200, 409])
  assert.equal((await request('GET', guestPath(room, 'state'), { user: member })).body.party.playing, false)
  await request('PATCH', ownerPath(room), { user: host, body: { memberVisibility: false } })
  await assert.rejects(request('PATCH', path, { user: member, body }), { status: 401 })
})

test('temporary YouTube viewer leases inherit the current access ticket and recheck it after reading the body', async t => {
  const { user, request, start, guestPath, ownerPath, viewerReports } = fixture(t)
  const host = user('test-host')
  const member = user('test-member')
  const room = (await request('POST', '/api/quick-rooms', { user: host,
    body: { source: 'youtube', guestAccess: true } })).body
  start(room, host)
  const exchange = await request('POST', guestPath(room, 'session'), { body: { password: room.secret } })
  const cookie = exchange.headers['Set-Cookie'].split(';')[0]
  const { party } = (await request('GET', guestPath(room, 'state'), { cookie })).body
  const path = guestPath(room, 'viewers')
  const body = { partyId: party.id, playerId: randomUUID(), revision: 1 }
  await assert.rejects(request('POST', path, { body }), { status: 401 })
  await assert.rejects(request('POST', path, { user: member, body }), { status: 401 })
  await assert.rejects(request('GET', path, { cookie }), { status: 405 })
  assert.equal((await request('POST', path, { cookie, body })).status, 204)
  assert.equal((await request('DELETE', path, { cookie, body: { ...body, revision: 2 } })).status, 204)
  await assert.rejects(request('POST', path, { cookie, body, beforeBody: () =>
    request('PATCH', ownerPath(room), { user: host, body: { renewPassword: true, memberVisibility: true } }) }), { status: 401 })
  assert.equal((await request('POST', path, { user: member, body })).status, 204)
  assert.deepEqual(viewerReports, [
    { roomId: room.publicId, playerId: body.playerId, method: 'POST', guest: true },
    { roomId: room.publicId, playerId: body.playerId, method: 'DELETE', guest: true },
    { roomId: room.publicId, playerId: body.playerId, method: 'POST', guest: false },
  ])
})

test('temporary chat uses the same guest access as playback and identifies signed-in participants', async t => {
  const { user, request, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const room = (await request('POST', '/api/quick-rooms', { user: host,
    body: { source: 'screen', guestAccess: true } })).body
  const join = guestPath(room, 'chat/join')
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const body = { deviceId: randomUUID(), publicKey: publicKey.export({ format: 'jwk' }) }
  await assert.rejects(request('POST', join, { body }), { status: 401 })
  const { body: hostChat } = await request('POST', join, { user: host, body })
  assert.deepEqual(hostChat.peers.map(({ name, guest }) => ({ name, guest })), [{ name: 'test-host', guest: false }])
  const redeemed = await request('POST', guestPath(room, 'session'), { body: { password: room.secret } })
  const cookie = redeemed.headers['Set-Cookie'].split(';')[0]
  const deviceId = randomUUID()
  await request('POST', join, { cookie, body: { ...body, deviceId } })
  const chat = `${guestPath(room, 'chat')}?deviceId=${deviceId}&after=0`
  const { body: guestChat } = await request('GET', chat, { cookie })
  assert.equal(guestChat.deviceId, deviceId)
  assert.equal(guestChat.peers.find(peer => peer.id === deviceId).guest, true)
  assert.deepEqual((await request('POST', guestPath(room, 'chat/leave'), { cookie, body: { deviceId } })).body, { ok: true })
  assert.equal((await request('GET', chat, { cookie })).body.deviceId, deviceId)
  await request('DELETE', ownerPath(room), { user: host })
  await assert.rejects(request('GET', chat, { cookie }), { status: 404 })
})

test('temporary chat admits distinct browsers within a shared network quota and keeps devices private', async t => {
  const { user, request, guestPath, ownerPath } = fixture(t)
  const host = user('test-host')
  const otherHost = user('other-host')
  const create = user => request('POST', '/api/quick-rooms', { user, body: { source: 'screen', guestAccess: true } })
    .then(({ body }) => body)
  const room = await create(host)
  const otherRoom = await create(otherHost)
  const redeem = (room, address) => request('POST', guestPath(room, 'session'), { address, body: { password: room.secret } })
    .then(({ headers }) => headers['Set-Cookie'].split(';')[0])
  const firstAddress = '192.0.2.10'
  const secondAddress = '192.0.2.11'
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const key = publicKey.export({ format: 'jwk' })
  const join = (room, cookie, address, deviceId = randomUUID()) =>
    request('POST', guestPath(room, 'chat/join'), { cookie, address, body: { deviceId, publicKey: key } })
  const firstTicket = await redeem(room, firstAddress)
  const secondTicket = await redeem(room, firstAddress)
  assert.notEqual(firstTicket, secondTicket)
  const first = (await join(room, firstTicket, firstAddress)).body
  const read = `${guestPath(room, 'chat')}?deviceId=${first.deviceId}`
  await assert.rejects(request('GET', read, { cookie: secondTicket, address: firstAddress }), { status: 409 })
  for (const cookie of [firstTicket, secondTicket, await redeem(room, firstAddress), await redeem(room, firstAddress)]) {
    for (let index = cookie === firstTicket ? 1 : 0; index < 4; index++) await join(room, cookie, firstAddress)
  }
  const nextTicket = await redeem(room, firstAddress)
  await assert.rejects(join(room, nextTicket, firstAddress), { status: 429 })

  const { body } = await join(room, await redeem(room, secondAddress), secondAddress)
  assert.equal(body.peers.length, 17)
  assert.deepEqual(Object.keys(body.peers[0]), ['id', 'publicKey', 'name', 'guest'])
  assert.equal((await request('GET', read, { cookie: firstTicket, address: secondAddress })).body.deviceId, first.deviceId)
  assert.equal((await join(otherRoom, await redeem(otherRoom, firstAddress), firstAddress)).body.peers.length, 1)

  await request('POST', guestPath(room, 'chat/leave'), { cookie: firstTicket, address: secondAddress,
    body: { deviceId: first.deviceId } })
  assert.equal((await join(room, nextTicket, firstAddress)).body.peers.length, 17)
  await assert.rejects(request('GET', read, { cookie: firstTicket, address: secondAddress }), { status: 409 })

  const rotated = (await request('PATCH', ownerPath(room), { user: host, body: { renewPassword: true } })).body
  await assert.rejects(join(room, nextTicket, firstAddress), { status: 401 })
  assert.equal((await join(room, await redeem(rotated, firstAddress), firstAddress)).body.peers.length, 1)
})
