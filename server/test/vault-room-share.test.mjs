import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

globalThis.document = { querySelector() { return null }, documentElement: { lang: 'en' } }
globalThis.location = new URL('https://rooms.example.test/#/vault')
globalThis.localStorage = { getItem() { return null } }
const { canShareVaultPlayback, loadVaultPlaybackRooms } = await import('../../web/vault-room-share.js')

test('room playback entry points require own ready, unlocked media within the authenticated reader limit', () => {
  const user = { id: randomUUID() }
  const entry = { kind: 'file', state: 'ready', ownerId: user.id, name: 'private-video.mp4', type: 'video/mp4', descriptor: { size: 10 * 1024 ** 3 } }
  assert.equal(canShareVaultPlayback(entry, user), true)
  assert.equal(canShareVaultPlayback({ ...entry, type: 'audio/mpeg', name: 'music.mp3' }, user), true)
  for (const changed of [
    { ownerId: randomUUID() }, { receivedShareId: randomUUID() }, { state: 'uploading' }, { locked: true }, { kind: 'folder' },
    { descriptor: { size: 10 * 1024 ** 3 + 1 } }, { descriptor: { size: -1 } }, { descriptor: { size: NaN } },
    { name: 'private.svg', type: 'image/svg+xml' }, { name: 'document.pdf', type: 'application/pdf' },
  ]) assert.equal(canShareVaultPlayback({ ...entry, ...changed }, user), false, JSON.stringify(changed))
  assert.equal(canShareVaultPlayback(entry, { id: randomUUID() }), false)
  assert.equal(canShareVaultPlayback(entry, undefined), false)
})

test('room chooser follows every topic page, excludes unjoined and temporary rooms, and deduplicates identities', async () => {
  const joined = { id: randomUUID(), title: 'Joined room', joined: true }
  const older = { id: randomUUID(), title: 'Older joined room', joined: true }
  const cursor = '2026-11-18T00:00:00Z|' + randomUUID()
  const calls = []
  const rooms = await loadVaultPlaybackRooms({ request: async path => {
    calls.push(path)
    if (calls.length === 1) return { topics: [joined, { id: randomUUID(), title: 'Public unjoined room', joined: false },
      { id: randomUUID(), title: 'Temporary room', joined: true, temporary: true }], next: cursor }
    return { topics: [joined, older, { id: '../invalid', title: 'Malformed room', joined: true }], next: null }
  } })
  assert.deepEqual(calls, ['topics', 'topics?before=' + encodeURIComponent(cursor)])
  assert.deepEqual(rooms.map(room => room.id), [joined.id, older.id])
})

test('room chooser fails on repeated pagination cursors and cancellation without issuing extra requests', async () => {
  let calls = 0
  await assert.rejects(loadVaultPlaybackRooms({ request: async () => { calls++; return { topics: [], next: 'repeated' } } }), /could not be completed/)
  assert.equal(calls, 2)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loadVaultPlaybackRooms({ signal: controller.signal, request: async () => { calls++; return { topics: [] } } }), { name: 'AbortError' })
  assert.equal(calls, 2)
  await assert.rejects(loadVaultPlaybackRooms({ request: async () => ({ topics: null }) }), /could not be loaded/)
})
