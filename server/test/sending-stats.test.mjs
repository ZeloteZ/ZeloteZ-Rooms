import assert from 'node:assert/strict'
import test from 'node:test'
import { createSendingStats } from '../../web/sending-stats.js'

function clock(t) {
  let current = 0
  t.mock.method(performance, 'now', () => current)
  return milliseconds => { current = milliseconds }
}

function rtp(timestamp, bytesSent, framesEncoded, extra = {}, remote = {}) {
  return new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent, framesEncoded,
      frameWidth: 1920, frameHeight: 1080, codecId: 'codec', remoteId: 'remote', ...extra }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', kind: 'video', timestamp,
      localId: 'video', fractionLost: 0.02, jitter: 0.004, ...remote }],
    ['audio', { id: 'audio', type: 'outbound-rtp', kind: 'audio', timestamp, bytesSent: bytesSent * 20 }],
    ['inbound', { id: 'inbound', type: 'inbound-rtp', kind: 'video', timestamp, bytesReceived: bytesSent * 40 }],
    ['other-remote', { id: 'other-remote', type: 'remote-inbound-rtp', kind: 'video', localId: 'unrelated',
      timestamp, fractionLost: 1, jitter: 10 }],
    ['rtx-codec', { id: 'rtx-codec', type: 'codec', mimeType: 'video/rtx' }],
    ['rtx', { id: 'rtx', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: bytesSent * 50,
      frameWidth: 4096, frameHeight: 2160, codecId: 'rtx-codec' }],
  ])
}

test('sender rates measure actual outgoing video and linked remote receiver reports', async t => {
  const advance = clock(t)
  let reports = rtp(100, 1000, 1)
  const stats = createSendingStats({ getStats: async () => reports })
  t.after(() => stats.destroy())
  assert.equal((await stats.sample()).mbps, null)

  advance(1000)
  reports = rtp(1100, 876000, 61)
  assert.deepEqual(await stats.sample(), {
    elapsed: 1, width: 1920, height: 1080, fps: 60, mbps: 7,
    packetLoss: 2, jitterMs: 4, framesDropped: null, codec: 'H264',
  })
})

test('sender loss falls back to intervals entirely within remote received/lost counters', async t => {
  clock(t)
  let reports = rtp(100, 1_000_000, 50, {},
    { fractionLost: undefined, packetsReceived: 100, packetsLost: 2 })
  const stats = createSendingStats({ getStats: async () => reports })
  t.after(() => stats.destroy())
  assert.equal((await stats.sample()).packetLoss, null)
  reports = rtp(1100, 9_000_000, 100, { packetsSent: 10_000 },
    { fractionLost: undefined, packetsReceived: 198, packetsLost: 4 })
  assert.equal((await stats.sample()).packetLoss, 2)

  // Between RTCP updates, the latest interval remains valid until the report becomes old.
  reports = rtp(2100, 10_000_000, 150, {},
    { timestamp: 1100, fractionLost: undefined, packetsReceived: 198, packetsLost: 4 })
  assert.equal((await stats.sample()).packetLoss, 2)
  reports = rtp(3100, 11_000_000, 200, {},
    { fractionLost: undefined, packetsReceived: 10, packetsLost: -1 })
  assert.equal((await stats.sample()).packetLoss, null)
})

test('old, future, regressing and unlinked remote reports cannot become current send quality', async t => {
  clock(t)
  let reports = rtp(20_000, 1000, 1, {}, { timestamp: 19_000 })
  const stats = createSendingStats({ getStats: async () => reports })
  t.after(() => stats.destroy())
  assert.equal((await stats.sample()).packetLoss, 2)

  for (const remoteTimestamp of [100, 21_001, 18_000]) {
    reports = rtp(21_000, 2000, 2, {}, { timestamp: remoteTimestamp })
    const measured = await stats.sample()
    assert.equal(measured.packetLoss, null)
    assert.equal(measured.jitterMs, null)
  }
  reports = rtp(22_000, 3000, 3, {}, { localId: 'audio' })
  const unlinked = await stats.sample()
  assert.equal(unlinked.packetLoss, null)
  assert.equal(unlinked.jitterMs, null)
})

test('adaptation is not invented dropped frames and unavailable/reset counters remain unknown', async t => {
  clock(t)
  let reports = rtp(100, 1000, 1, { qualityLimitationReason: 'cpu', framesSent: 1, mediaSourceId: 'source' })
  reports.set('source', { id: 'source', type: 'media-source', kind: 'video', frames: 1000 })
  const stats = createSendingStats({ getStats: async () => reports })
  t.after(() => stats.destroy())
  assert.equal((await stats.sample()).framesDropped, null)
  reports = rtp(1100, 1, 0, { framesDropped: 5 })
  const restarted = await stats.sample()
  assert.equal(restarted.mbps, null)
  assert.equal(restarted.fps, null)
  assert.equal(restarted.framesDropped, 5)
  reports = new Map()
  const missing = await stats.sample()
  assert.deepEqual(missing, { elapsed: 0, width: null, height: null, fps: null, mbps: null,
    packetLoss: null, jitterMs: null, framesDropped: null, codec: null })
})

test('stopping a sender discards pending stats and freezes elapsed time', async t => {
  const advance = clock(t)
  let resolve
  const stats = createSendingStats({ getStats: () => new Promise(done => { resolve = done }) })
  advance(1000)
  const pending = stats.sample()
  advance(1500)
  stats.destroy()
  resolve(rtp(100, 9_000_000, 900, { framesPerSecond: 900 }))
  const stopped = await pending
  assert.equal(stopped.elapsed, 1.5)
  assert.equal(stopped.fps, null)
  assert.equal(stopped.packetLoss, null)
  advance(9000)
  assert.equal((await stats.sample()).elapsed, 1.5)
})
