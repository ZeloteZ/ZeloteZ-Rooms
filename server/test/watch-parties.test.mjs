import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createAuth } from '../auth.mjs'
import { createCommunity } from '../community.mjs'
import { createWatchParties } from '../watch-parties.mjs'

const chunk = 4 * 1024 ** 2

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rooms-watch-test-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const auth = createAuth(db, { publicOrigin: 'http://127.0.0.1' })
  db.exec('CREATE TABLE topic_designers (topic_id TEXT, user_id TEXT)')
  const community = createCommunity(db, { ...auth, appearance: { profile: () => ({}) } })
  let now = 100_000
  const watch = createWatchParties({ ...auth, dataDir, channelAccess: community.channelAccess, now: () => now })
  t.after(async () => {
    watch.close()
    community.close()
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const timestamp = new Date().toISOString()
  const users = Object.fromEntries(['host', 'viewer', 'moderator', 'stranger'].map(name => [name, randomUUID()]))
  const insertUser = db.prepare(`INSERT INTO users(id, username, display_name, password_hash, admin, public_key, identity, created_at)
    VALUES (?, ?, ?, 'unused', 0, '{}', '{}', ?)`)
  for (const [name, id] of Object.entries(users)) insertUser.run(id, name, name, timestamp)
  const channel = randomUUID()
  const room = randomUUID()
  db.prepare("INSERT INTO topics(id, owner_id, title, visibility, created_at) VALUES (?, ?, 'Watch test', 'private', ?)")
    .run(room, users.host, timestamp)
  const joinRoom = db.prepare('INSERT INTO topic_members(topic_id, user_id, role, joined_at, approved) VALUES (?, ?, ?, ?, 1)')
  joinRoom.run(room, users.host, 'owner', timestamp)
  joinRoom.run(room, users.viewer, 'member', timestamp)
  joinRoom.run(room, users.moderator, 'admin', timestamp)
  db.prepare("INSERT INTO channels(id, topic_id, title, type, stream_policy) VALUES (?, ?, 'Live', 'live', 'admins')")
    .run(channel, room)
  const base = `/api/channels/${channel}/watch`

  function session(userId) {
    const token = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest()
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, userId, Math.floor(Date.now() / 1000) + 600)
    return {
      userId, token, revoke: () => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash),
      leave: () => db.prepare('DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?').run(room, userId),
    }
  }

  async function request(actor, method = 'GET', relative = '', body, headers = {}) {
    const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const fixtureRequest = Readable.from(bytes === null ? [] : [bytes])
    fixtureRequest.method = method
    fixtureRequest.headers = {
      ...(actor && { cookie: `zelotez_session=${actor.token}`, 'x-rooms-account': actor.userId }),
      ...(bytes && { 'content-length': String(bytes.length), 'content-type': 'application/json' }),
      ...headers,
    }
    const chunks = []
    const response = new Writable({ write(data, _encoding, done) { chunks.push(data); done() } })
    response.writeHead = (statusCode, responseHeaders) => {
      response.statusCode = statusCode
      response.headers = responseHeaders
      return response
    }
    assert.equal(await watch.handle(fixtureRequest, response, new URL(base + relative, 'http://127.0.0.1')), true)
    const buffer = Buffer.concat(chunks)
    return {
      status: response.statusCode, headers: response.headers, bytes: buffer,
      ...(response.headers?.['Content-Type']?.startsWith('application/json') && { data: JSON.parse(buffer) }),
    }
  }

  async function waitForCleanup() {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await readdir(join(dataDir, 'watch-videos'))).length) return
      await delay(5)
    }
    assert.fail('Watch party files were left behind')
  }

  return { request, session, users, waitForCleanup, tick: milliseconds => { now += milliseconds } }
}

test('a watch party follows Live channel permissions and synchronizes play, seek and pause', async t => {
  const { request, session, users, tick } = await fixture(t)
  const host = session(users.host)
  const viewer = session(users.viewer)
  const moderator = session(users.moderator)
  const stranger = session(users.stranger)
  const source = { source: 'youtube', videoId: 'K5ABskPJN1Q' }
  await assert.rejects(request(null), { status: 401 })
  await assert.rejects(request(stranger), { status: 404 })
  await assert.rejects(request(viewer, 'POST', '', source), { status: 403 })
  await assert.rejects(request(host, 'POST', '', { ...source, videoId: 'https://www.youtube.com/' }), { status: 400 })
  const created = await request(host, 'POST', '', source)
  assert.equal(created.status, 201)
  const path = `/${created.data.party.id}`
  assert.equal(created.data.party.playing, false)
  assert.equal(created.data.party.revision, 1)
  await assert.rejects(request(moderator, 'POST', '', source), { status: 409 })
  assert.equal((await request(viewer)).data.canShare, false)
  assert.equal((await request(viewer)).data.party.videoId, source.videoId)
  await assert.rejects(request(stranger, 'PATCH', path, { action: 'play', revision: 1 }), { status: 404 })
  await assert.rejects(request(viewer, 'DELETE', path), { status: 404 })

  const play = (await request(viewer, 'PATCH', path, { action: 'play', revision: 1 })).data
  assert.equal(play.party.playing, true)
  tick(3000)
  const playing = (await request(host)).data
  assert.equal(playing.party.position + (playing.serverTime - playing.party.updatedAt) / 1000, 3)
  await assert.rejects(request(host, 'PATCH', path, { action: 'pause', revision: 1 }), { status: 409 })
  const seek = (await request(moderator, 'PATCH', path, { action: 'seek', position: 62.5, revision: 2 })).data
  assert.equal(seek.canStop, true)
  assert.equal(seek.party.playing, true)
  tick(2250)
  const pause = (await request(host, 'PATCH', path, { action: 'pause', revision: 3 })).data
  assert.equal(pause.party.playing, false)
  assert.equal(pause.party.position, 64.75)
  const replay = (await request(host, 'PATCH', path, { action: 'play', position: 0, revision: pause.party.revision })).data.party
  assert.equal(replay.position, 0)
  assert.equal(replay.playing, true)
  assert.equal((await request(moderator, 'DELETE', path)).data.party, null)
  assert.equal((await request(viewer)).data.party, null)
})

test('the server stores original video chunks and serves authenticated byte ranges until the watch party ends', async t => {
  const { request, session, users, waitForCleanup } = await fixture(t)
  const host = session(users.host)
  const otherDevice = session(users.host)
  const viewer = session(users.viewer)
  const stranger = session(users.stranger)
  const first = Buffer.alloc(chunk)
  first.writeUInt32BE(24)
  first.write('ftypisom', 4)
  const tail = Buffer.from('The end of the original clip data.')
  const source = { source: 'local', mime: 'video/mp4', size: first.length + tail.length, title: 'Clip\u202e.mp4' }
  const fileHeader = { 'content-type': 'application/octet-stream' }
  await assert.rejects(request(host, 'POST', '', { ...source, mime: 'text/html' }), { status: 415 })
  await assert.rejects(request(host, 'POST', '', { ...source, size: 256 * 1024 ** 2 + 1 }), { status: 413 })
  const draft = (await request(host, 'POST', '', source)).data.party
  assert.equal(draft.state, 'uploading')
  assert.equal(draft.title, 'Clip .mp4')
  assert.equal((await request(viewer)).data.party, null)
  const path = `/${draft.id}`
  await assert.rejects(request(viewer, 'GET', `${path}/media`), { status: 404 })
  await assert.rejects(request(otherDevice, 'PUT', `${path}/upload?offset=0`, first, fileHeader), { status: 404 })
  await assert.rejects(request(host, 'PUT', `${path}/upload?offset=32`, first, fileHeader), { status: 409 })
  const uploading = (await request(host, 'PUT', `${path}/upload?offset=0`, first, fileHeader)).data
  assert.equal(uploading.offset, chunk)
  assert.equal(uploading.complete, false)
  await assert.rejects(request(host, 'PUT', `${path}/upload?offset=0`, first, fileHeader), { status: 409 })
  const ready = (await request(host, 'PUT', `${path}/upload?offset=${chunk}`, tail, fileHeader)).data
  assert.equal(ready.complete, true)
  assert.equal(ready.party.state, 'ready')
  const posted = (await request(viewer)).data.party
  assert.equal(posted.mediaUrl, ready.party.mediaUrl)
  const headers = (await request(viewer, 'HEAD', `${path}/media`)).headers
  assert.equal(headers['Content-Length'], first.length + tail.length)
  assert.equal(headers['Content-Type'], source.mime)
  assert.equal(headers['Accept-Ranges'], 'bytes')
  const partial = await request(viewer, 'GET', `${path}/media`, undefined, { range: `bytes=${chunk}-` })
  assert.deepEqual(partial.bytes, tail)
  assert.equal(partial.status, 206)
  assert.equal(partial.headers['Content-Range'], `bytes ${chunk}-${source.size - 1}/${source.size}`)
  const suffix = await request(viewer, 'GET', `${path}/media`, undefined, { range: 'bytes=-5' })
  assert.deepEqual(suffix.bytes, tail.subarray(-5))
  const unavailable = await request(viewer, 'GET', `${path}/media`, undefined, { range: `bytes=${source.size}-` })
  assert.equal(unavailable.status, 416)
  assert.equal(unavailable.headers['Content-Range'], `bytes */${source.size}`)
  assert.deepEqual((await request(viewer, 'GET', `${path}/media`)).bytes, Buffer.concat([first, tail]))
  await assert.rejects(request(stranger, 'HEAD', `${path}/media`), { status: 404 })
  viewer.leave()
  await assert.rejects(request(viewer, 'GET', `${path}/media`), { status: 404 })
  host.revoke()
  assert.equal((await request(otherDevice)).data.party, null)
  await waitForCleanup()
})

test('bad video signatures and abandoned uploads release their reservations', async t => {
  const { request, session, users, tick, waitForCleanup } = await fixture(t)
  const host = session(users.host)
  const viewer = session(users.viewer)
  const bad = Buffer.alloc(24)
  bad.write('<html>Not a video')
  const source = { source: 'local', mime: 'video/webm', size: bad.length }
  const fileHeader = { 'content-type': 'application/octet-stream' }
  const first = (await request(host, 'POST', '', source)).data.party
  await assert.rejects(request(host, 'PUT', `/${first.id}/upload?offset=0`, bad, fileHeader), { status: 415 })
  assert.equal((await request(host)).data.party, null)

  const good = Buffer.alloc(24)
  Buffer.from('1a45dfa3874282847765626d', 'hex').copy(good)
  const second = (await request(host, 'POST', '', source)).data.party
  await request(host, 'PUT', `/${second.id}/upload?offset=0`, good, fileHeader)
  assert.deepEqual((await request(viewer, 'GET', `/${second.id}/media`)).bytes, good)
  await request(host, 'DELETE', `/${second.id}`)

  const third = (await request(host, 'POST', '', source)).data.party
  assert.equal(third.state, 'uploading')
  tick(3 * 60_000 + 1)
  assert.equal((await request(host)).data.party, null)
  await waitForCleanup()
})
