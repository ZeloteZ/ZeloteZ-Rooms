import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = (await readFile(new URL('../../web/native-broadcast.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gmu, '')
  .replace('export function createNativeBroadcast', 'function createNativeBroadcast') +
  '\nthis.createNativeBroadcast = createNativeBroadcast'
const firstStream = '1'.repeat(32)
const secondStream = '2'.repeat(32)

function fixture() {
  const pending = [], bitmaps = [], painted = [], animation = new Map()
  let tick = 0, observeStatus, observeFrame, canvas
  class Element extends EventTarget {
    constructor(tag, attributes, children) {
      super()
      this.tag = tag
      this.hidden = Boolean(attributes.hidden)
      this.isConnected = true
      this.children = children.flat().filter(Boolean)
      this.width = 300
      this.height = 150
      if (tag === 'canvas') canvas = this
    }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children }
    setAttribute() {}
    focus() {}
    getContext() { return { drawImage: bitmap => painted.push(bitmap.id) } }
  }
  const element = (tag, attributes = {}, ...children) => new Element(tag, attributes, children)
  const document = Object.assign(new EventTarget(), { hidden: false })
  const context = {
    EventTarget, Event, CustomEvent, ArrayBuffer, Blob, Intl, document,
    language: () => 'en', t: en => en, button: () => element('button'),
    el: element, notify() {}, topicHref: () => '#/rooms/room/channel',
    mountSendingStats: () => ({ element: element('div'), reset() {} }),
    window: { roomsNativeCapture: {
      observe(status, frame) { observeStatus = status; observeFrame = frame; return () => {} },
      status: () => new Promise(() => {}),
    } },
    createImageBitmap(blob) {
      return new Promise((resolve, reject) => pending.push({ blob, resolve, reject }))
    },
    requestAnimationFrame(callback) { animation.set(++tick, callback); return tick },
    cancelAnimationFrame(id) { animation.delete(id) },
  }
  runInNewContext(source, context)
  const global = new AbortController(), view = new AbortController()
  const broadcast = context.createNativeBroadcast(global.signal, element('div'))
  broadcast.mount({ id: 'room' }, { id: 'channel', title: 'Channel' }, view.signal)
  function status(streamId = firstStream) { observeStatus({ channelId: 'channel', streamId }) }
  status()
  return {
    view, global, document, pending, bitmaps, painted, animation,
    canvas: () => canvas, status, frame: id => observeFrame(firstStream, new Uint8Array([id])),
    nextStreamFrame: id => observeFrame(secondStream, new Uint8Array([id])),
    async resolveFrame() {
      const decoder = pending.shift()
      assert.ok(decoder, 'a single image decode should be waiting')
      const id = new Uint8Array(await decoder.blob.arrayBuffer())[0]
      const bitmap = { id, width: 640, height: 360, closes: 0, close() { this.closes++ } }
      bitmaps.push(bitmap)
      decoder.resolve(bitmap)
      await new Promise(resolve => setImmediate(resolve))
      return bitmap
    },
    paint() {
      for (const [id, callback] of [...animation]) {
        animation.delete(id)
        callback()
      }
    },
  }
}

test('native preview retains the newest JPEG during decoding and paints once per animation frame', async () => {
  const f = fixture()
  f.frame(1)
  f.frame(2)
  f.frame(3)
  assert.equal(f.pending.length, 1)
  const old = await f.resolveFrame()
  assert.equal(f.pending.length, 1)
  assert.equal(f.animation.size, 1)
  const latest = await f.resolveFrame()
  assert.equal(f.pending.length, 0)
  assert.equal(old.closes, 1)
  assert.equal(f.animation.size, 1)
  f.paint()
  assert.deepEqual(f.painted, [3])
  assert.equal(latest.closes, 1)
  assert.equal(f.canvas().hidden, false)
  f.global.abort()
})

test('native preview discards pending frames after hiding, switching streams and leaving the view', async () => {
  const f = fixture()
  f.frame(1)
  f.frame(2)
  f.document.hidden = true
  f.document.dispatchEvent(new Event('visibilitychange'))
  const hidden = await f.resolveFrame()
  assert.equal(hidden.closes, 1)
  assert.equal(f.pending.length, 0)
  assert.equal(f.animation.size, 0)
  f.document.hidden = false
  f.frame(3)
  f.status(secondStream)
  f.nextStreamFrame(4)
  const switched = await f.resolveFrame()
  assert.equal(switched.closes, 1)
  const current = await f.resolveFrame()
  assert.equal(f.animation.size, 1)
  f.view.abort()
  assert.equal(current.closes, 1)
  assert.equal(f.animation.size, 0)
  f.paint()
  assert.deepEqual(f.painted, [])
  f.global.abort()
})
