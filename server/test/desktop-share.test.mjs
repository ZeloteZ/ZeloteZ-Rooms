import assert from 'node:assert/strict'
import test from 'node:test'

test('desktop sharing validates native settings and preserves capture boundaries', async t => {
  class Node extends EventTarget {
    children = []
    setAttribute(name, value) { this[name] = String(value) }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children }
  }
  class Track extends EventTarget {
    constructor(kind = 'video') { super(); this.kind = kind; this.readyState = 'live' }
    stop() { this.readyState = 'ended' }
    getSettings() { return { width: 640, height: 360, displaySurface: 'window' } }
    async applyConstraints(constraints) { this.constraints = constraints }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks }
    getTracks() { return [...this.tracks] }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video') }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
    addTrack(track) { this.tracks.push(track) }
    removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track) }
  }
  const changed = ['document', 'window', 'location', 'localStorage', 'navigator', 'MediaStream', 'RTCPeerConnection', 'AudioContext', 'AudioWorkletNode', 'fetch']
  const previous = new Map(changed.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  set('document', { querySelector: () => new Node(), createElement: () => new Node() })
  set('location', new URL('https://rooms.example.test/'))
  set('localStorage', { getItem: () => null })
  set('MediaStream', Stream)
  set('RTCPeerConnection', class {})
  set('AudioWorkletNode', class { port = { postMessage() {} }; connect() {} })
  const { desktopShareSettings, normalizedDesktopRegion } = await import('../../web/desktop-share.js')
  const { createScreenShareController } = await import('../../web/screen-share.js')
  const { createChannelCapture } = await import('../../web/channel-capture.js')
  const settings = { height: 1080, fps: 30, audio: 'none', region: null }
  const region = { x: .1, y: .2, width: .5, height: .5, aspect: 16 / 9, sourceWidth: 1921, sourceHeight: 1081 }

  await t.test('normalized crop rounds inward and rejects changed sources or invalid rectangles', () => {
    const rect = normalizedDesktopRegion(region, 1921, 1081)
    assert.deepEqual(rect, { x: 193, y: 217, width: 959, height: 539 })
    assert.ok(rect.x >= region.x * 1921)
    assert.ok(rect.y >= region.y * 1081)
    assert.ok(rect.x + rect.width <= (region.x + region.width) * 1921)
    assert.ok(rect.y + rect.height <= (region.y + region.height) * 1081)
    assert.throws(() => normalizedDesktopRegion(region, 1080, 1920), /changed size/)
    assert.throws(() => normalizedDesktopRegion({ ...region, width: .001 }, 1921, 1081), /too small/)
    assert.throws(() => normalizedDesktopRegion({ ...region, x: -.1 }, 1921, 1081), /invalid/)
    assert.throws(() => normalizedDesktopRegion({ ...region, x: .9 }, 1921, 1081), /invalid/)
    assert.throws(() => normalizedDesktopRegion(region, 3842, 2162), /changed size/)
    assert.throws(() => normalizedDesktopRegion({ ...region, aspect: NaN }, 1920, 1080), /changed size/)
    assert.deepEqual(desktopShareSettings({ ...settings, region }), { ...settings, region })
    for (const value of [{ ...settings, height: 2160 }, { ...settings, fps: 120 }, { ...settings, audio: 'tab' }, { ...settings, region: true }]) {
      assert.throws(() => desktopShareSettings(value), /invalid/)
    }
  })

  function environment(selection, armed = true) {
    const calls = []
    const input = new Track()
    const source = new Stream([input])
    set('window', Object.assign(new EventTarget(), {
      roomsDesktop: true,
      roomsDesktopShare: {
        arm(id, lang) { calls.push(['arm', id, lang]); return Promise.resolve(armed) },
        async take(id) { calls.push(['take', id]); return selection },
        async cancel(id) { calls.push(['cancel', id]) },
      },
      roomsDesktopAudio: {
        supportedModes: ['application', 'system'],
        async open(id, mode) { calls.push(['audio-open', id, mode]); return 'cancelled' },
        async close(id) { calls.push(['audio-close', id]) },
      },
    }))
    set('AudioContext', class {
      constructor() { calls.push(['audio-context']); this.audioWorklet = { addModule: async () => {} } }
      async resume() {}
      async close() { calls.push(['context-close']) }
      createMediaStreamDestination() { return { stream: new Stream([new Track('audio')]) } }
    })
    set('navigator', { mediaDevices: { async getDisplayMedia(options) { calls.push(['capture', options]); return source } } })
    set('fetch', async () => { calls.push(['reservation']); return Response.json({}) })
    const abort = new AbortController()
    const share = createScreenShareController({ signal: abort.signal }, new Node())
    return { calls, input, share, abort }
  }
  const room = { id: '00000000-0000-4000-8000-000000000001' }
  const channel = { id: '00000000-0000-4000-8000-000000000002', title: 'Live' }

  await t.test('unified capture initializes audio on the original click and releases it when none is chosen', async () => {
    const { calls, input, share, abort } = environment({ ...settings, fps: 60 })
    const pending = share.start(room, channel, false, { unified: true })
    assert.deepEqual(calls.map(call => call[0]), ['audio-context', 'arm'])
    await assert.rejects(pending, /invalid stream destination/)
    const id = calls.find(call => call[0] === 'arm')[1]
    assert.deepEqual(calls.filter(call => call[0] === 'take'), [['take', id]])
    assert.deepEqual(calls.filter(call => call[0] === 'audio-close'), [['audio-close', id]])
    assert.equal(calls.filter(call => call[0] === 'capture').length, 1)
    assert.equal(calls.find(call => call[0] === 'capture')[1].audio, false)
    assert.equal(calls.find(call => call[0] === 'capture')[1].video.frameRate.max, 60)
    assert.equal(calls.some(call => call[0] === 'audio-open'), false)
    assert.equal(input.readyState, 'ended')
    assert.deepEqual(input.constraints, { frameRate: { ideal: 60, max: 60 } })
    assert.equal(share.active(), null)
    abort.abort()
  })

  await t.test('chosen native audio consumes the same setup UUID without another selector', async () => {
    const { calls, input, share, abort } = environment({ ...settings, audio: 'application' })
    await share.start(room, channel, false, { unified: true })
    const id = calls.find(call => call[0] === 'arm')[1]
    assert.deepEqual(calls.filter(call => call[0] === 'audio-open'), [['audio-open', id, 'application']])
    assert.equal(calls.filter(call => call[0] === 'capture').length, 1)
    assert.equal(calls.some(call => call[0] === 'reservation'), false)
    assert.equal(input.readyState, 'ended')
    assert.equal(share.active(), null)
    abort.abort()
  })

  await t.test('unavailable Web Audio still permits video-only selection and reports failure only for selected audio', async () => {
    for (const audio of ['none', 'system']) {
      const { calls, input, share, abort } = environment({ ...settings, audio })
      set('AudioContext', class { constructor() { throw new Error('Unavailable device') } })
      const pending = share.start(room, channel, false, { unified: true })
      await assert.rejects(pending, audio === 'none' ? /invalid stream destination/ : /audio mixer/)
      assert.equal(calls.some(call => call[0] === 'reservation'), audio === 'none')
      assert.equal(calls.filter(call => call[0] === 'capture').length, 1)
      assert.equal(input.readyState, 'ended')
      abort.abort()
    }
  })

  await t.test('cancelled or invalid setup never reserves a stream or leaves capture running', async () => {
    for (const [selection, armed] of [[null, true], [settings, false], [{ ...settings, region: { ...region, width: 2 } }, true]]) {
      const { calls, input, share, abort } = environment(selection, armed)
      const pending = share.start(room, channel, false, { unified: true })
      if (!armed) await assert.rejects(pending, /cancelled or denied/)
      else if (selection?.region) await assert.rejects(pending, /invalid/)
      else await pending
      assert.equal(calls.some(call => call[0] === 'reservation'), false)
      assert.equal(calls.filter(call => call[0] === 'cancel').length, 1)
      assert.equal(calls.filter(call => call[0] === 'audio-close').length, 1)
      if (armed) assert.equal(input.readyState, 'ended')
      else assert.equal(calls.some(call => call[0] === 'capture'), false)
      assert.equal(share.active(), null)
      abort.abort()
    }
  })

  await t.test('shared channel controls use unified mode while old desktop and browser controls remain available', async () => {
    environment(settings)
    const starts = []
    const screenShare = { async start(...args) { starts.push(args) } }
    const capture = createChannelCapture({ room, screenShare }, channel)
    assert.equal(capture.options, null)
    await capture.start()
    assert.deepEqual(starts[0], [room, channel, undefined, { unified: true }])
    delete window.roomsDesktopShare
    assert.notEqual(createChannelCapture({ room, screenShare }, channel).options, null)
    delete window.roomsDesktop
    assert.notEqual(createChannelCapture({ room, screenShare }, channel).options, null)
    window.roomsNativeCapture = { async open() { return 'opened' } }
    const native = createChannelCapture({ room, screenShare }, channel)
    assert.equal(native.options, null)
    await native.start()
    assert.equal(starts.length, 1)
  })
})
