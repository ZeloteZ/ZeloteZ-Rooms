import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAppearance } from '../appearance.mjs'
import { initializeAuthSchema } from '../auth.mjs'
import { RequestError } from '../http.mjs'

const alice = '00000000-0000-4000-8000-000000000001'
const bob = '00000000-0000-4000-8000-000000000002'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rooms-profile-playback-'))
  const filename = join(directory, 'community.sqlite')
  const connections = new Set()
  t.after(() => {
    for (const db of connections) db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const db = new DatabaseSync(filename)
  connections.add(db)
  db.exec('PRAGMA foreign_keys = ON')
  initializeAuthSchema(db)
  const insert = db.prepare(`INSERT INTO users(id, username, display_name, password_hash, admin, public_key, identity, created_at)
    VALUES (?, ?, ?, 'unused', 0, '{}', '{}', ?)`)
  insert.run(alice, 'alice', 'Alice', new Date().toISOString())
  insert.run(bob, 'bob', 'Bob', new Date().toISOString())
  db.exec(`
    CREATE TABLE topics(id TEXT PRIMARY KEY);
    CREATE TABLE topic_members(topic_id TEXT, user_id TEXT, PRIMARY KEY(topic_id, user_id));
    CREATE TABLE profile_appearance(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name_color TEXT) STRICT;
  `)
  db.prepare("INSERT INTO profile_appearance VALUES (?, '#aabbcc')").run(alice)

  function connect(database = new DatabaseSync(filename)) {
    connections.add(database)
    database.exec('PRAGMA foreign_keys = ON')
    const appearance = createAppearance(database)
    const requireSession = request => {
      if (!request.userId) throw new RequestError(401, 'Bitte melde dich an.')
      return { id: request.userId }
    }
    return {
      appearance,
      db: database,
      async request(userId, method = 'GET', input) {
        const bytes = input === undefined ? [] : [Buffer.from(JSON.stringify(input))]
        const request = Object.assign(Readable.from(bytes), { method, userId, headers: { 'content-type': 'application/json' } })
        let output
        const response = {
          writeHead(status) { assert.equal(status, 200) },
          end(body) { output = JSON.parse(body) },
        }
        assert.equal(await appearance.handle(request, response, '/api/profile', requireSession), true)
        return output.profile
      },
      close() {
        database.close()
        connections.delete(database)
      },
    }
  }
  return { first: connect(db), connect }
}

test('video reception statistics default off on upgrade and persist privately per account', async t => {
  const { first, connect } = fixture(t)
  const original = await first.request(alice)
  assert.equal(original.nameColor, '#aabbcc')
  assert.equal(original.showVideoStats, false)
  assert.equal((await first.request(alice, 'PATCH', { showVideoStats: true })).showVideoStats, true)
  assert.equal((await first.request(bob)).showVideoStats, false)
  assert.equal(Object.hasOwn(first.appearance.profile(alice), 'showVideoStats'), false)
  await first.request(alice, 'PATCH', { notifyLive: true })
  first.close()
  const restarted = connect()
  assert.equal((await restarted.request(alice)).showVideoStats, true)
  assert.equal((await restarted.request(alice)).notifyLive, true)
  assert.equal((await restarted.request(alice, 'PATCH', { showVideoStats: false })).showVideoStats, false)
  restarted.db.prepare('DELETE FROM users WHERE id = ?').run(alice)
  assert.equal(restarted.db.prepare('SELECT 1 FROM profile_playback_preferences WHERE user_id = ?').get(alice), undefined)
})

test('profile video-stat changes require authentication and a boolean with atomic validation', async t => {
  const { first } = fixture(t)
  await assert.rejects(first.request(null), { status: 401 })
  await assert.rejects(first.request(null, 'PATCH', { showVideoStats: true }), { status: 401 })
  const original = await first.request(alice, 'PATCH', { showVideoStats: true })
  for (const value of [null, 0, 1, 'true', [], {}]) {
    await assert.rejects(first.request(alice, 'PATCH', { nameColor: '#112233', showVideoStats: value }), { status: 400 })
    assert.deepEqual(await first.request(alice), original)
  }
  await assert.rejects(first.request(alice, 'PATCH', { showVideoStats: false, userId: bob }), { status: 400 })
  assert.equal((await first.request(alice)).showVideoStats, true)
})
