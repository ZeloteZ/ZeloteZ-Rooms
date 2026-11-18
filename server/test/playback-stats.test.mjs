import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackStats } from '../../web/playback-stats.js'

class Video extends EventTarget {
  paused = true
  ended = false
  readyState = 4
  videoWidth = 1920
  videoHeight = 1080
  frames = 0
  dropped = 0

  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.frames, droppedVideoFrames: this.dropped }
  }

  play() {
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  }

  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

function clock(t) {
  let current = 0
  t.mock.method(performance, 'now', () => current)
  return milliseconds => { current = milliseconds }
}

function rtp(timestamp, bytesReceived, framesDecoded, extra = {}) {
  return new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp, bytesReceived, framesDecoded,
      codecId: 'codec', ...extra }],
    ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: bytesReceived * 20 }],
    ['sender', { id: 'sender', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: bytesReceived * 40 }],
    ['rtx-codec', { id: 'rtx-codec', type: 'codec', mimeType: 'video/rtx' }],
    ['rtx', { id: 'rtx', type: 'inbound-rtp', kind: 'video', timestamp, bytesReceived: bytesReceived * 50,
      codecId: 'rtx-codec' }],
  ])
}

test('viewer WebRTC rates use only incoming video counters and reset with the receiver', async t => {
  const advance = clock(t)
  const video = new Video()
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  let reports = rtp(100, 1000, 1)
  stats.setPeer({ getStats: async () => reports })
  video.play()
  assert.equal((await stats.sample()).mbps, null)

  advance(1000)
  video.frames = 60
  reports = rtp(1100, 876000, 61)
  const measured = await stats.sample()
  assert.deepEqual(measured, { elapsed: 1, width: 1920, height: 1080, fps: 60, mbps: 7,
    packetLoss: null, jitterMs: null, framesDropped: 0, codec: 'H264' })

  advance(2000)
  reports = rtp(2100, 1, 1)
  const restarted = await stats.sample()
  assert.equal(restarted.mbps, null)
  assert.equal(restarted.fps, 0)
  stats.setPeer({ getStats: async () => rtp(100, 9_000_000, 900) })
  advance(3000)
  assert.equal((await stats.sample()).mbps, null)
})

test('HLS rates count received media bytes while decoded FPS and viewing time follow playback', async t => {
  const advance = clock(t)
  const video = new Video()
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  const events = new Map()
  const hls = { on: (name, callback) => events.set(name, callback), off: name => events.delete(name) }
  stats.setHls(hls, { Events: { FRAG_LOADED: 'loaded' } })
  video.play()
  await stats.sample()
  events.get('loaded')('loaded', { frag: { type: 'main' }, payload: { byteLength: 875000 } })
  events.get('loaded')('loaded', { frag: { type: 'audio' }, payload: { byteLength: 9_000_000 } })
  advance(1000)
  video.frames = 60
  video.dropped = 5
  assert.deepEqual(await stats.sample(), { elapsed: 1, width: 1920, height: 1080, fps: 55, mbps: 7,
    packetLoss: null, jitterMs: null, framesDropped: 5, codec: null })

  video.pause()
  advance(2000)
  assert.deepEqual(await stats.sample(), { elapsed: 1, width: 1920, height: 1080, fps: 0, mbps: 0,
    packetLoss: null, jitterMs: null, framesDropped: 5, codec: null })
  video.play()
  video.dispatchEvent(new Event('stalled'))
  advance(3000)
  video.frames = 90
  events.get('loaded')('loaded', { frag: { type: 'main' }, part: { stats: { loaded: 500000 } } })
  assert.deepEqual(await stats.sample(), { elapsed: 2, width: 1920, height: 1080, fps: 30, mbps: 4,
    packetLoss: null, jitterMs: null, framesDropped: 5, codec: null })

  stats.reset()
  assert.equal(events.size, 0)
  const unknown = await stats.sample()
  assert.equal(unknown.elapsed, 0)
  assert.equal(unknown.mbps, null)
  assert.equal(unknown.fps, 0)
})

test('unavailable native bandwidth and changed transports never show stale receiver samples', async t => {
  const advance = clock(t)
  const video = new Video()
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  video.play()
  assert.equal((await stats.sample()).mbps, null)
  advance(1000)
  video.frames = 30
  assert.equal((await stats.sample()).fps, 30)
  let resolve
  stats.setPeer({ getStats: () => new Promise(done => { resolve = done }) })
  const pending = stats.sample()
  stats.reset()
  resolve(rtp(100, 9_000_000, 900, { framesPerSecond: 900, jitter: 0.5, framesDropped: 100 }))
  const changed = await pending
  assert.equal(changed.fps, null)
  assert.equal(changed.mbps, null)
  assert.equal(changed.elapsed, 0)
  assert.equal(changed.packetLoss, null)
  assert.equal(changed.jitterMs, null)
  assert.equal(changed.framesDropped, 0)
  assert.equal(changed.codec, null)
  stats.destroy()
  video.play()
  advance(5000)
  assert.equal((await stats.sample()).elapsed, 0)
})

test('viewer quality uses primary incoming video loss intervals, jitter and receiver dropped frames', async t => {
  const advance = clock(t)
  const video = new Video()
  video.dropped = 2
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  let reports = rtp(100, 1000, 1, { packetsReceived: 1000, packetsLost: 10,
    jitter: 0.015, framesDropped: 3 })
  for (const id of ['audio', 'sender', 'rtx']) {
    Object.assign(reports.get(id), { packetsReceived: 5000, packetsLost: 5000, jitter: 999, framesDropped: 999 })
  }
  stats.setPeer({ getStats: async () => reports })
  const first = await stats.sample()
  assert.equal(first.packetLoss, null)
  assert.equal(first.jitterMs, 15)
  assert.equal(first.framesDropped, 3)
  assert.equal(first.codec, 'H264')

  advance(1000)
  Object.assign(reports.get('video'), { timestamp: 1100, packetsReceived: 1090, packetsLost: 20,
    jitter: 0.005, framesDropped: 7 })
  const next = await stats.sample()
  assert.equal(next.packetLoss, 10)
  assert.equal(next.jitterMs, 5)
  assert.equal(next.framesDropped, 7)

  advance(2000)
  Object.assign(reports.get('video'), { timestamp: 2100, packetsReceived: 1190, jitter: 0 })
  assert.equal((await stats.sample()).packetLoss, 0)
  assert.equal((await stats.sample()).jitterMs, 0)
})

test('viewer packet loss becomes unknown for counter corrections, resets and empty intervals', async t => {
  clock(t)
  const stats = createPlaybackStats(new Video())
  t.after(() => stats.destroy())
  let timestamp = 0
  let reports
  stats.setPeer({ getStats: async () => reports })
  async function sample(packetsReceived, packetsLost) {
    reports = rtp(timestamp += 1000, 0, 0, { packetsReceived, packetsLost })
    return (await stats.sample()).packetLoss
  }
  assert.equal(await sample(100, -1), null)
  assert.equal(await sample(200, 2), null)
  assert.equal(await sample(290, 12), 10)
  assert.equal(await sample(390, 11), null)
  assert.equal(await sample(490, 11), 0)
  assert.equal(await sample(1, 0), null)
  assert.equal(await sample(1, 0), null)
  assert.equal(await sample(1, 10), 100)
  assert.equal(await sample(NaN, 11), null)
  assert.equal(await sample(20, 12), null)
  assert.equal(await sample(20, undefined), null)
})

test('unsupported reception metrics stay unknown and decoded playback drops provide the fallback', async t => {
  clock(t)
  const video = new Video()
  video.dropped = 9
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  const reports = rtp(100, 0, 0, { jitter: -1, framesDropped: -1 })
  reports.get('codec').mimeType = 'video/VP8'
  stats.setPeer({ getStats: async () => reports })
  const sample = await stats.sample()
  assert.equal(sample.packetLoss, null)
  assert.equal(sample.jitterMs, null)
  assert.equal(sample.framesDropped, 9)
  assert.equal(sample.codec, 'VP8')

  video.getVideoPlaybackQuality = undefined
  video.webkitDroppedFrameCount = 12
  assert.equal((await stats.sample()).framesDropped, 12)
  video.webkitDroppedFrameCount = undefined
  assert.equal((await stats.sample()).framesDropped, null)
  reports.get('codec').mimeType = 'video/https://example.invalid/bogus'
  assert.equal((await stats.sample()).codec, null)
  reports.get('codec').mimeType = `video/${'x'.repeat(65)}`
  assert.equal((await stats.sample()).codec, null)
})

test('HLS reports active video codec and playback drops without inventing RTP measurements', async t => {
  clock(t)
  const video = new Video()
  video.dropped = 4
  const stats = createPlaybackStats(video)
  t.after(() => stats.destroy())
  const events = new Map()
  const hls = { currentLevel: 0, levels: [{ videoCodec: 'avc1.640028' }],
    on: (name, callback) => events.set(name, callback), off: name => events.delete(name) }
  const Hls = { Events: { FRAG_LOADED: 'loaded', FRAG_PARSING_INIT_SEGMENT: 'init' } }
  stats.setHls(hls, Hls)
  const fallback = await stats.sample()
  assert.equal(fallback.codec, 'avc1.640028')
  assert.equal(fallback.framesDropped, 4)
  assert.equal(fallback.packetLoss, null)
  assert.equal(fallback.jitterMs, null)
  events.get('init')('init', { tracks: { video: { codec: 'hvc1.1.6.L93.B0' } } })
  assert.equal((await stats.sample()).codec, 'hvc1.1.6.L93.B0')
  events.get('init')('init', { tracks: { audio: { codec: 'mp4a.40.2' } } })
  assert.equal((await stats.sample()).codec, 'hvc1.1.6.L93.B0')

  stats.setPeer(null)
  assert.equal(events.size, 0)
  assert.equal((await stats.sample()).codec, null)
  stats.setHls(hls, Hls)
  assert.equal((await stats.sample()).codec, 'avc1.640028')
  stats.destroy()
  assert.equal(events.size, 0)
  assert.equal((await stats.sample()).codec, null)
})
