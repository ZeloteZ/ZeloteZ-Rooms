import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAuth } from '../auth.mjs'
import { createCommunity } from '../community.mjs'
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
  let time = Date.now()
  const media = { hasGuestSource: id => current.has(id), guestSnapshot: ({ channelId }) => ({
    serverTime: time, party: current.get(channelId),
  }) }
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

  async function request(method, path, { user: actor, cookie = actor?.cookie, body } = {}) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    stream.method = method
    stream.headers = { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) }
    stream.socket = { remoteAddress: '127.0.0.1' }
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
    current.set(room.channelId, { id: randomUUID(), title: 'Shared clip', source: room.source, position: 0, playing: false })
    quick.noteTemporarySource(room.channelId, owner.id)
  }

  const guestPath = (room, action) => `/api/guest/${room.publicId}/${action}`
  const ownerPath = room => `/api/quick-rooms/${room.publicId}`
  return { db, user, request, quick, start, guestPath, ownerPath,
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

test('guest passwords are hashed and redeem only a scoped read capability, which rotation and revocation invalidate', async t => {
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
