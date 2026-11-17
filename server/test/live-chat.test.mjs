import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { createAuth } from '../auth.mjs'
import { createChannelManagement } from '../channel-management.mjs'
import { createCommunity } from '../community.mjs'
import { createHistory } from '../history.mjs'
import { RequestError } from '../http.mjs'
import { createNotifications } from '../notifications.mjs'
import { createReactions } from '../reactions.mjs'
import { createStreamChat } from '../stream-chat.mjs'

const origin = 'https://rooms.example.com'
const encoded = size => randomBytes(size).toString('base64url')
const point = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
const keyBox = () => ({ nonce: encoded(12), blob: encoded(48) })
const envelopeFor = (...users) => ({ v: 1, ephemeral: point(), nonce: encoded(12), body: encoded(80),
  keys: Object.fromEntries(users.map(user => [user.id, keyBox()])) })

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const { requireSession } = createAuth(db, { publicOrigin: origin })
  db.exec('CREATE TABLE topic_designers (topic_id TEXT, user_id TEXT)')
  const appearance = { topic: () => ({}), profile: () => ({}), designPermission: () => false }
  const community = createCommunity(db, { requireSession, appearance, recordMentions: input => notifications.recordMentions(input) })
  db.exec('CREATE TABLE broadcasts(id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT, publisher_id TEXT, ended_at INTEGER) STRICT')
  const streams = { chatChannel(streamId, userId) {
    const stream = db.prepare('SELECT channel_id FROM broadcasts WHERE id = ? AND ended_at IS NULL').get(streamId)
    if (!stream || !community.channelAccess(userId, stream.channel_id)) throw new RequestError(404)
    return stream.channel_id
  } }
  const history = createHistory(db, { requireSession })
  const streamChat = createStreamChat(db, { requireSession, community, streams, profileFor: appearance.profile })
  const reactions = createReactions(db, { requireSession, streams })
  const notifications = createNotifications(db, { requireSession, streams })
  const channels = createChannelManagement(db, { requireSession })
  const handlers = [notifications, reactions, streamChat, history, channels, community]
  t.after(() => {
    community.close()
    db.close()
  })

  function user(username) {
    const id = randomUUID()
    const secret = encoded(32)
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)')
      .run(id, username, username, '', 0, JSON.stringify(point()), '{}', new Date().toISOString())
    db.prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(createHash('sha256').update(secret).digest(), id, Math.floor(Date.now() / 1000) + 600)
    return { id, cookie: '__Host-zelotez_session=' + secret }
  }

  async function request(method, path, actor, body, writeChunk) {
    const binary = Buffer.isBuffer(body)
    const incoming = Readable.from(body === undefined ? [] : [binary ? body : Buffer.from(JSON.stringify(body))])
    incoming.method = method
    incoming.headers = { cookie: actor?.cookie,
      ...(body !== undefined && { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) }
    const chunks = []
    const response = new Writable({ write(data, _encoding, done) {
      chunks.push(data)
      if (writeChunk) writeChunk(done, this)
      else done()
    } })
    let headers
    response.writeHead = (status, values = {}) => { response.status = status; headers = values; return response }
    const url = new URL(path, origin)
    for (const handler of handlers) {
      if (await handler.handle(incoming, response, url)) {
        const bytes = chunks.length ? Buffer.concat(chunks) : undefined
        const body = bytes && (headers['Content-Type']?.startsWith('application/json') ? JSON.parse(bytes) : bytes)
        return { status: response.status, headers, body }
      }
    }
    throw new Error('Unhandled test route ' + path)
  }
  return { db, user, request }
}

async function attachmentFixture(t) {
  const { db, user, request } = fixture(t)
  const owner = user('Owner')
  const viewer = user('Viewer')
  const { body: { topic } } = await request('POST', '/api/topics', owner, { title: 'Files', visibility: 'public' })
  const room = '/api/topics/' + topic.id
  await request('POST', room + '/join', viewer, {})
  const { body: { channels } } = await request('GET', room, owner)
  const channelId = channels.find(channel => channel.type === 'chat').id
  const channel = '/api/channels/' + channelId
  const id = randomUUID()
  const file = channel + '/files/' + id
  const message = randomUUID()
  const post = attachmentIds => request('POST', channel + '/messages', owner,
    { id: message, envelope: envelopeFor(owner, viewer), attachmentIds })
  return { db, user, request, owner, viewer, room, channelId, channel, id, file, message, post }
}

test('regular live chat persists independently of broadcasts and is limited to current members of the channel', async t => {
  const { db, user, request } = fixture(t)
  const owner = user('Owner')
  const viewer = user('Viewer')
  const other = user('Other')
  const { body: { topic } } = await request('POST', '/api/topics', owner, { title: 'Studio', visibility: 'public' })
  const { body: { channel } } = await request('POST', '/api/topics/' + topic.id + '/channels', owner,
    { title: 'Screenings', type: 'live', streamPolicy: 'admins' })
  const channelPath = '/api/channels/' + channel.id
  const messages = channelPath + '/messages'
  await assert.rejects(request('GET', messages), { status: 401 })
  await assert.rejects(request('GET', messages, other), { status: 404 })
  await request('POST', '/api/topics/' + topic.id + '/join', viewer, {})

  const id = randomUUID()
  const envelope = envelopeFor(owner, viewer)
  const { status: sent } = await request('POST', messages, viewer, { id, envelope, attachmentIds: [], mentionedUserIds: [owner.id] })
  assert.equal(sent, 201)
  const { body: { notifications } } = await request('GET', '/api/notifications', owner)
  assert.equal(notifications[0].source, 'chat')
  assert.equal(notifications[0].channelId, channel.id)
  assert.equal(notifications[0].messageId, id)
  assert.equal((await request('GET', '/api/mentions?channelId=' + channel.id, viewer)).status, 200)

  const broadcast = randomBytes(16).toString('hex')
  db.prepare('INSERT INTO broadcasts VALUES (?,?,?,?,NULL)').run(broadcast, channel.id, owner.id, 'publisher')
  const legacy = '/api/streams/' + broadcast + '/chat'
  const legacyId = randomUUID()
  assert.equal((await request('POST', legacy, viewer, { id: legacyId, envelope })).status, 201)
  assert.deepEqual((await request('GET', legacy, owner)).body.messages.map(message => message.id), [legacyId])
  db.prepare('UPDATE broadcasts SET ended_at = ? WHERE id = ?').run(Date.now(), broadcast)
  assert.equal(db.prepare('SELECT count(*) AS total FROM stream_messages').get().total, 0)
  const { body } = await request('GET', messages, owner)
  assert.deepEqual(body.messages.map(message => message.id), [id])
  assert.deepEqual(body.messages[0].envelope, envelope)

  const { body: { channel: otherChannel } } = await request('POST', '/api/topics/' + topic.id + '/channels', owner,
    { title: 'Other live channel', type: 'live' })
  assert.deepEqual((await request('GET', '/api/channels/' + otherChannel.id + '/messages', owner)).body.messages, [])
  await assert.rejects(request('DELETE', '/api/channels/' + otherChannel.id + '/messages/' + id, owner, {}), { status: 404 })

  await request('POST', '/api/topics/' + topic.id + '/join', other, {})
  assert.deepEqual((await request('GET', messages, other)).body.messages, [])
  const { body: { job } } = await request('GET', '/api/history/pending', owner)
  assert.equal(job.channelId, channel.id)
  assert.equal(job.recipient.id, other.id)
  assert.equal(job.messages[0].id, id)
  const grantorId = owner.id
  const recipientId = other.id
  const wrapper = { v: 1, ephemeral: point(), ...keyBox() }
  assert.equal((await request('POST', channelPath + '/history-grants', owner,
    { grantorId, recipientId, grants: [{ messageId: id, wrapper }] })).body.granted, 1)
  assert.deepEqual((await request('GET', messages, other)).body.messages[0].envelope.historyGrant,
    { ...wrapper, grantorId, revision: 1 })

  const reactionId = encoded(32)
  const reactionsPath = messages + '/reactions'
  assert.equal((await request('PUT', reactionsPath + '/' + id + '/' + reactionId, other,
    { nonce: encoded(12), body: encoded(48) })).status, 204)
  assert.equal((await request('GET', reactionsPath + '?ids=' + id, viewer)).body.reactions[0].id, reactionId)

  assert.equal((await request('DELETE', '/api/topics/' + topic.id + '/join', viewer)).status, 200)
  await assert.rejects(request('GET', messages, viewer), { status: 404 })
  await assert.rejects(request('GET', reactionsPath + '?ids=' + id, viewer), { status: 404 })
  assert.equal((await request('DELETE', channelPath, owner)).status, 204)
  assert.equal(db.prepare('SELECT count(*) AS total FROM messages').get().total, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('temporary stream rooms do not expose persistent chat APIs even to their owner', async t => {
  const { db, user, request } = fixture(t)
  const owner = user('Owner')
  const { body: { topic } } = await request('POST', '/api/topics', owner, { title: 'Transient', visibility: 'private' })
  const { body: { channels } } = await request('GET', '/api/topics/' + topic.id, owner)
  const live = channels.find(channel => channel.type === 'live')
  const now = Date.now()
  db.prepare(`INSERT INTO quick_rooms(topic_id,channel_id,owner_id,owner_session,source,member_visibility,created_at,draft_until,expires_at)
    VALUES (?,?,?,?, 'screen', 0, ?, ?, ?)`).run(topic.id, live.id, owner.id, 'session', now, now + 5000, now + 50000)
  const channelPath = '/api/channels/' + live.id
  const id = randomUUID()
  await assert.rejects(request('GET', channelPath + '/messages', owner), { status: 404 })
  await assert.rejects(request('POST', channelPath + '/messages', owner,
    { id, envelope: envelopeFor(owner), attachmentIds: [] }), { status: 404 })
  await assert.rejects(request('GET', channelPath + '/messages/reactions?ids=' + id, owner), { status: 404 })
  await assert.rejects(request('GET', '/api/mentions?channelId=' + live.id, owner), { status: 404 })
})

test('chat attachments stream the exact uploaded bytes to current recipients and are deleted with their message', async t => {
  const { db, user, request, owner, viewer, room, channel, id, file, message, post } = await attachmentFixture(t)
  const bytes = randomBytes(2 * 256 * 1024 + 117)
  assert.equal((await request('PUT', file, owner, randomBytes(bytes.length + 256 * 1024))).status, 201)
  assert.equal((await request('PUT', file, owner, bytes)).status, 201)
  await assert.rejects(request('GET', file, owner), { status: 404 })
  assert.equal((await post([id])).status, 201)

  const stranger = user('Stranger')
  await assert.rejects(request('GET', file, stranger), { status: 404 })
  await request('POST', room + '/join', stranger, {})
  await assert.rejects(request('GET', file, stranger), { status: 404 })
  await assert.rejects(request('GET', file + '?maxBytes=0', viewer), { status: 400 })
  assert.equal((await request('GET', file + '?maxBytes=' + (bytes.length - 1), viewer)).status, 204)
  const result = await request('GET', file + '?maxBytes=' + bytes.length, viewer)
  assert.equal(result.status, 200)
  assert.equal(result.headers['Content-Length'], bytes.length)
  assert.equal(result.headers['Content-Disposition'], 'attachment')
  assert.deepEqual(result.body, bytes)
  const countChunks = db.prepare('SELECT count(*) AS count FROM attachment_chunks WHERE attachment_id = ?')
  assert.equal(countChunks.get(id).count, 3)

  assert.equal((await request('DELETE', channel + '/messages/' + message, owner, {})).status, 200)
  await assert.rejects(request('GET', file, viewer), { status: 404 })
  assert.equal(countChunks.get(id).count, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('the first authorized read of a legacy attachment moves its bytes into chunks', async t => {
  const { db, user, request, owner, viewer, channelId, id, file, message, post } = await attachmentFixture(t)
  const bytes = randomBytes(2 * 256 * 1024 + 29)
  assert.equal((await post([])).status, 201)
  db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?)').run(id, channelId, owner.id, message, bytes, bytes.length, Date.now())
  const legacySize = db.prepare('SELECT length(bytes) AS length FROM attachments WHERE id = ?')
  const countChunks = db.prepare('SELECT count(*) AS count FROM attachment_chunks WHERE attachment_id = ?')

  await assert.rejects(request('GET', file, user('Stranger')), { status: 404 })
  assert.equal((await request('GET', file + '?maxBytes=1', viewer)).status, 204)
  assert.equal(legacySize.get(id).length, bytes.length)
  assert.equal(countChunks.get(id).count, 0)
  assert.deepEqual((await request('GET', file, viewer)).body, bytes)
  assert.equal(legacySize.get(id).length, 0)
  assert.equal(countChunks.get(id).count, 3)
  assert.deepEqual((await request('GET', file, viewer)).body, bytes)
})

test('attachment downloads limit simultaneous reads and stop when a connection closes or access is removed', async t => {
  const { request, owner, viewer, room, id, file, post } = await attachmentFixture(t)
  const bytes = randomBytes(256 * 1024 + 32)
  await request('PUT', file, owner, bytes)
  await post([id])
  const firstWrite = Promise.withResolvers()
  const secondWrite = Promise.withResolvers()
  const drain = Promise.withResolvers()
  const heldWrite = signal => (done, response) => {
    signal.resolve(response)
    drain.promise.then(() => done())
  }
  const first = request('GET', file, viewer, undefined, heldWrite(firstWrite))
  const second = request('GET', file, viewer, undefined, heldWrite(secondWrite))
  try {
    const [connection] = await Promise.all([firstWrite.promise, secondWrite.promise])
    await assert.rejects(request('GET', file, viewer), { status: 429 })
    connection.destroy()
    await assert.rejects(first, { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    assert.deepEqual((await request('GET', file, viewer)).body, bytes)
    assert.equal((await request('DELETE', room + '/join', viewer)).status, 200)
  } finally {
    drain.resolve()
    await Promise.allSettled([first, second])
  }
  await assert.rejects(second, { status: 404 })
  assert.deepEqual((await request('GET', file, owner)).body, bytes)
})
