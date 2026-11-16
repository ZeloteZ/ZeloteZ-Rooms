import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAuth } from '../auth.mjs'
import { createCommunity } from '../community.mjs'
import { createPresence } from '../presence.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const auth = createAuth(db, { publicOrigin: 'http://127.0.0.1' })
  db.exec('CREATE TABLE topic_designers (topic_id TEXT, user_id TEXT)')
  const community = createCommunity(db, { ...auth, appearance: { profile: () => ({}) } })
  let time = 0
  const presence = createPresence(db, { ...auth, now: () => time })
  t.after(() => {
    presence.close()
    community.close()
    db.close()
  })

  const stamp = new Date().toISOString()
  const users = Object.fromEntries(['alice', 'bob', 'carol', 'dana', 'eve'].map(name => [name, randomUUID()]))
  const insertUser = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, admin, public_key, identity, created_at)
    VALUES (?, ?, ?, 'unused', 0, '{}', '{}', ?)`)
  for (const [name, id] of Object.entries(users)) insertUser.run(id, name, name, stamp)

  function connect(userId) {
    const token = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest()
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, userId, Math.floor(Date.now() / 1000) + 600)
    return { userId, token, close: () => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash) }
  }

  async function query(session, userIds, extra = {}) {
    const body = Buffer.from(JSON.stringify({ userIds, ...extra }))
    const request = Readable.from([body])
    request.method = 'POST'
    request.headers = {
      'content-type': 'application/json',
      ...(session ? { cookie: `zelotez_session=${session.token}`, 'x-rooms-account': session.userId } : {}),
    }
    let output
    assert.equal(await presence.handle(request, {
      writeHead(status) { assert.equal(status, 200) },
      end(body) { output = JSON.parse(body) },
    }, '/api/presence'), true)
    return output
  }

  function makeRoom(owner, visitor, direct = false) {
    const room = randomUUID()
    db.prepare("INSERT INTO topics(id, owner_id, title, visibility, created_at) VALUES (?, ?, 'Test room', 'private', ?)")
      .run(room, owner, stamp)
    const joinRoom = db.prepare(`INSERT INTO topic_members(topic_id, user_id, role, joined_at, approved)
      VALUES (?, ?, ?, ?, 1)`)
    joinRoom.run(room, owner, direct ? 'member' : 'owner', stamp)
    joinRoom.run(room, visitor, 'member', stamp)
    if (direct) {
      const channel = randomUUID()
      db.prepare("INSERT INTO channels(id, topic_id, title, type, stream_policy) VALUES (?, ?, 'Direct', 'chat', 'all')")
        .run(channel, room)
      db.prepare(`INSERT INTO direct_conversations(id, first_id, second_id, topic_id, channel_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), ...[owner, visitor].sort(), room, channel, stamp)
    }
    return room
  }

  return { db, users, connect, query, makeRoom, tick: duration => { time += duration } }
}

test('presence requires authentication and is shared only with accepted friends and joined room members', async t => {
  const { db, users: { alice, bob, carol, dana, eve }, connect, query, makeRoom } = fixture(t)
  const actor = connect(alice)
  const friend = db.prepare('INSERT INTO friendships VALUES (?, ?, ?, ?)')
  friend.run(...[alice, bob].sort(), alice, 1)
  friend.run(...[alice, dana].sort(), alice, 0)
  const shared = makeRoom(alice, carol)
  makeRoom(alice, eve, true)
  await assert.rejects(query(null, [alice, bob]), { status: 401 })
  await assert.rejects(query(actor, ['invalid']), { status: 400 })
  await assert.rejects(query(actor, [bob], { account: bob }), { status: 400 })
  await assert.rejects(query(actor, Array(201).fill(alice)), { status: 400 })
  assert.deepEqual(await query(actor, Array(200).fill(alice)), { online: [alice] })
  await Promise.all([bob, carol, dana, eve].map(user => query(connect(user), [])))
  const ids = [alice, bob, carol, dana, eve]
  assert.deepEqual(await query(actor, ids), { online: [alice, bob, carol] })
  db.prepare('DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?').run(shared, carol)
  assert.deepEqual(await query(actor, ids), { online: [alice, bob] })
})

test('session revocation and expiry remove presence without removing another active device', async t => {
  const { db, users: { alice, bob, carol }, connect, query, makeRoom, tick } = fixture(t)
  makeRoom(alice, bob)
  makeRoom(alice, carol)
  const viewer = connect(alice)
  const desktop = connect(bob)
  const mobile = connect(bob)
  const other = connect(carol)
  await query(desktop, [])
  await query(mobile, [])
  await query(other, [])
  desktop.close()
  assert.deepEqual(await query(viewer, [bob, carol]), { online: [bob, carol] })
  tick(104_999)
  assert.deepEqual(await query(viewer, [bob, carol]), { online: [bob, carol] })
  tick(1)
  assert.deepEqual(await query(viewer, [bob, carol]), { online: [] })
  await query(mobile, [])
  await query(other, [])
  mobile.close()
  db.prepare('INSERT INTO disabled_accounts VALUES (?, 1)').run(carol)
  assert.deepEqual(await query(viewer, [bob, carol]), { online: [] })
  await assert.rejects(query(other, []), { status: 401 })
})
