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
  assert.deepEqual(measured, { elapsed: 1, width: 1920, height: 1080, fps: 60, mbps: 7 })

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
  assert.deepEqual(await stats.sample(), { elapsed: 1, width: 1920, height: 1080, fps: 55, mbps: 7 })

  video.pause()
  advance(2000)
  assert.deepEqual(await stats.sample(), { elapsed: 1, width: 1920, height: 1080, fps: 0, mbps: 0 })
  video.play()
  advance(3000)
  video.frames = 90
  events.get('loaded')('loaded', { frag: { type: 'main' }, part: { stats: { loaded: 500000 } } })
  assert.deepEqual(await stats.sample(), { elapsed: 2, width: 1920, height: 1080, fps: 30, mbps: 4 })

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
  resolve(rtp(100, 9_000_000, 900, { framesPerSecond: 900 }))
  const changed = await pending
  assert.equal(changed.fps, null)
  assert.equal(changed.mbps, null)
  assert.equal(changed.elapsed, 0)
  stats.destroy()
  video.play()
  advance(5000)
  assert.equal((await stats.sample()).elapsed, 0)
})
