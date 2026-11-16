import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import { initializeAuthSchema } from '../auth.mjs'
import { RequestError } from '../http.mjs'
import { createTutorials } from '../tutorials.mjs'

const alice = '00000000-0000-4000-8000-000000000001'
const bob = '00000000-0000-4000-8000-000000000002'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rooms-tutorials-'))
  const filename = join(dir, 'community.sqlite')
  const connections = new Set()
  t.after(() => {
    for (const db of connections) db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function open() {
    const db = new DatabaseSync(filename, { timeout: 5000 })
    db.exec('PRAGMA foreign_keys = ON')
    connections.add(db)
    return db
  }

  const db = open()
  initializeAuthSchema(db)
  const insert = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, admin, public_key, identity, created_at)
    VALUES (?, ?, ?, 'unused', 0, '{}', '{}', ?)`)
  insert.run(alice, 'alice', 'Alice', new Date().toISOString())
  insert.run(bob, 'bob', 'Bob', new Date().toISOString())

  function connect(database = open()) {
    const { handle } = createTutorials(database, {
      requireSession(request) {
        if (!request.userId) throw new RequestError(401, 'Bitte melde dich an.')
        return { id: request.userId }
      },
    })
    return {
      async request(userId, method = 'GET', payload, stream = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : [])) {
        Object.assign(stream, { userId, method, headers: { 'content-type': 'application/json' } })
        let output
        const response = {
          writeHead(status) { assert.equal(status, 200) },
          end(body) { output = JSON.parse(body) },
        }
        assert.equal(await handle(stream, response, '/api/tutorials'), true)
        return output
      },
      close() {
        database.close()
        connections.delete(database)
      },
    }
  }

  return { connect, first: connect(db) }
}

test('tutorial chapters merge across devices, survive reopening SQLite and stay per account', async t => {
  const { connect, first } = fixture(t)
  const second = connect()
  const initial = { generation: 0, completed: [] }
  assert.deepEqual(await first.request(alice), initial)
  await assert.rejects(first.request(null), { status: 401 })
  await assert.rejects(first.request(alice, 'PATCH', { generation: 0, completed: ['other'] }), { status: 400 })
  await assert.rejects(first.request(alice, 'PATCH', { generation: 0, completed: ['home'], userId: bob }), { status: 400 })
  await Promise.all([
    first.request(alice, 'PATCH', { generation: 0, completed: ['home', 'join'] }),
    second.request(alice, 'PATCH', { generation: 0, completed: ['room', 'room'] }),
  ])
  first.close()
  second.close()
  const restarted = connect()
  assert.deepEqual(await restarted.request(alice), { generation: 0, completed: ['home', 'join', 'room'] })
  assert.deepEqual(await restarted.request(bob), initial)
})

test('reset invalidates both pending and retried writes from earlier tutorial generations', async t => {
  const { connect, first } = fixture(t)
  const second = connect()
  const pendingBody = new PassThrough()
  const pendingWrite = assert.rejects(second.request(alice, 'PATCH', undefined, pendingBody), { status: 409 })
  assert.deepEqual(await first.request(alice, 'DELETE', { generation: 0 }), { generation: 1, completed: [] })
  pendingBody.end(JSON.stringify({ generation: 0, completed: ['home'] }))
  await pendingWrite
  assert.deepEqual(await second.request(alice, 'PATCH', { generation: 1, completed: ['friends'] }),
    { generation: 1, completed: ['friends'] })
  await assert.rejects(first.request(alice, 'DELETE', { generation: 0 }), { status: 409 })
  assert.deepEqual(await first.request(alice), { generation: 1, completed: ['friends'] })
})
