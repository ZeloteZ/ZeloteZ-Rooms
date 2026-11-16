import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Run in the server image with a read-only root, only a writable test-data mount,
// and this test file mounted under /app/test. Point ROOMS_READ_ONLY_TEST_DIR at the mount.
const scratch = process.env.ROOMS_READ_ONLY_TEST_DIR

test('deletes a populated room on a read-only root filesystem and preserves other rooms', { skip: !scratch }, async t => {
  const dataDir = await mkdtemp(join(scratch, 'room-delete-'))
  const origin = 'http://127.0.0.1:18288'
  const env = { ...process.env, APP_DATA_DIR: dataDir, WATCH_MEDIA_DIR: dataDir, PUBLIC_ORIGIN: origin,
    HOST: '127.0.0.1', AUTH_HOST: '127.0.0.1', PORT: '18288', AUTH_PORT: '18289', TRUST_PROXY_IP: '0' }
  delete env.SQLITE_TMPDIR
  delete env.TMPDIR
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'ignore', 'inherit'] })
  const exited = new Promise(resolve => server.once('exit', resolve))
  t.after(async () => {
    server.kill('SIGTERM')
    await exited
    await rm(dataDir, { recursive: true, force: true })
  })

  for (let attempt = 0; ; attempt++) {
    const healthy = await fetch(origin + '/api/health').then(response => response.ok, () => false)
    if (healthy) break
    assert.equal(server.exitCode, null, 'The test server exited during startup')
    assert.ok(attempt < 100, 'The test server did not become ready')
    await delay(50)
  }

  const db = new DatabaseSync(join(dataDir, 'community.sqlite'))
  try {
    const at = new Date().toISOString()
    const user = randomUUID()
    const member = randomUUID()
    const token = randomBytes(32).toString('base64url')
    db.prepare("INSERT INTO users VALUES (?, 'test-owner', 'Test Owner', '', 0, '{}', '{}', ?)").run(user, at)
    db.prepare("INSERT INTO users VALUES (?, 'test-member', 'Test Member', '', 0, '{}', '{}', ?)").run(member, at)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest(), user,
      Math.floor(Date.now() / 1000) + 300)

    function request(method, path, body) {
      return fetch(origin + '/api/' + path, {
        method,
        headers: { Origin: origin, Cookie: 'zelotez_session=' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    }

    async function roomWithMessage(title) {
      const created = await request('POST', 'topics', { title, visibility: 'public' })
      assert.equal(created.status, 201)
      const { topic } = await created.json()
      const details = await (await request('GET', 'topics/' + topic.id)).json()
      const chat = details.channels.find(channel => channel.type === 'chat').id
      const live = details.channels.find(channel => channel.type === 'live').id
      const message = randomUUID()
      const attachment = randomUUID()
      const envelope = JSON.stringify({ keys: { [user]: {} } })
      db.prepare('INSERT INTO messages(id, channel_id, user_id, envelope, created_at) VALUES (?,?,?,?,?)').run(message, chat, user, envelope, at)
      db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?)')
        .run(attachment, chat, user, message, Buffer.alloc(40), 40, Date.now())
      db.prepare('INSERT INTO attachments VALUES (?,?,?,NULL,?,?,?)')
        .run(randomUUID(), chat, user, Buffer.alloc(40), 40, Date.now())
      db.prepare("INSERT INTO topic_members(topic_id,user_id,role,joined_at) VALUES (?,?,'member',?)")
        .run(topic.id, member, at)
      db.prepare('INSERT INTO topic_designers VALUES (?,?)').run(topic.id, member)
      db.prepare("INSERT INTO topic_appearance VALUES (?, '#ff0000', NULL, 'cover', 20)").run(topic.id)
      db.prepare("INSERT INTO appearance_images VALUES (?, NULL, ?, 'cover', ?)").run(randomUUID(), topic.id, Buffer.alloc(20))
      db.prepare("INSERT INTO message_history_grants(message_id,recipient_id,grantor_id,wrapper) VALUES (?,?,?,'{}')")
        .run(message, member, user)
      db.prepare('INSERT INTO message_history_rejections VALUES (?,?,?,1,?)')
        .run(message, member, user, Date.now())
      const broadcast = randomBytes(16).toString('hex')
      const streamMessage = randomUUID()
      const now = Date.now()
      db.prepare('INSERT INTO broadcasts(id,channel_id,user_id,key_hash,created_at,connect_until,publish_until,publisher_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(broadcast, live, user, randomBytes(32), now, now + 300000, now + 300000, randomUUID())
      db.prepare('INSERT INTO stream_messages(id,stream_id,user_id,envelope,created_at) VALUES (?,?,?,?,?)')
        .run(streamMessage, broadcast, user, envelope, at)
      const mention = db.prepare('INSERT INTO inbox_notifications(recipient_id,sender_id,kind,channel_id,chat_message_id,stream_message_id,created_at) VALUES (?,?,?,?,?,?,?)')
      mention.run(member, user, 'mention', chat, message, null, at)
      mention.run(member, user, 'mention', live, null, streamMessage, at)
      db.prepare("INSERT INTO inbox_notifications(recipient_id,sender_id,kind,channel_id,broadcast_id,created_at) VALUES (?,?,'live',?,?,?)")
        .run(member, user, live, broadcast, at)
      return { room: topic.id, chat, message, attachment, broadcast, streamMessage }
    }

    const removed = await roomWithMessage('Delete this room')
    const kept = await roomWithMessage('Keep this room')
    db.prepare('INSERT INTO message_reactions VALUES (?,?,?,?,?)')
      .run(removed.message, user, 'x'.repeat(43), 'x'.repeat(16), 'x'.repeat(64))

    const response = await request('DELETE', 'topics/' + removed.room)
    assert.equal(response.status, 204, await response.text())
    assert.equal((await request('GET', 'topics/' + removed.room)).status, 404)
    assert.equal((await request('GET', 'topics/' + kept.room)).status, 200)

    for (const [table, column, key] of [
      ['topic_members', 'topic_id', 'room'], ['channels', 'topic_id', 'room'], ['appearance_images', 'topic_id', 'room'],
      ['messages', 'id', 'message'], ['attachments', 'id', 'attachment'],
      ['message_history_grants', 'message_id', 'message'],
      ['message_history_rejections', 'message_id', 'message'],
      ['stream_messages', 'id', 'streamMessage'], ['inbox_notifications', 'chat_message_id', 'message'],
    ]) {
      const select = db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + column + ' = ?')
      assert.equal(select.get(removed[key]), undefined)
      assert.ok(select.get(kept[key]))
    }
    assert.ok(db.prepare('SELECT ended_at FROM broadcasts WHERE id = ?').get(removed.broadcast).ended_at)
    assert.equal(db.prepare('SELECT ended_at FROM broadcasts WHERE id = ?').get(kept.broadcast).ended_at, null)
    assert.equal(db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ?').get(removed.message), undefined)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})
