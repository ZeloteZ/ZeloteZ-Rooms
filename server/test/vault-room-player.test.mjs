import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Reuse the EventTarget/source model from the independent player review harness.
// Only the encrypted network opener is injected; duration/event helpers are real.
const moduleUrl = new URL('../../web/vault-room-player.js', import.meta.url)
const source = (await readFile(moduleUrl, 'utf8'))
  .replace('import { openVaultWatch } from "./vault-watch.js";', 'const openVaultWatch = options => globalThis.__vaultRoomReviewOpen(options);')
  .replace('import { mountVaultMediaLanguages } from "./vault-language-controls.js";', 'const mountVaultMediaLanguages = (...args) => globalThis.__vaultRoomLanguages(...args);')
  .replace(/from "\.\/([^"]+)"/gu, (_, path) => 'from ' + JSON.stringify(new URL(path, moduleUrl).href))
const { createVaultRoomPlayer } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const flush = () => new Promise(resolve => setImmediate(resolve))

class Element extends EventTarget {
  constructor(tag, owner, state) {
    super(); this.tag = tag; this.ownerDocument = owner; this.state = state; this.children = []; this.attributes = new Map()
    this.classList = { add() {} }; this.currentTime = 0; this.duration = 10; this.volume = 1; this.muted = false
    this.paused = true; this.pauseCalls = 0; this.loadCalls = 0; this.isConnected = false
    this.readyState = state.data === 'pending' ? 1 : 2; this.videoWidth = state.picture ? 640 : 0; this.videoHeight = state.picture ? 360 : 0
    this.bounds = { width: 640, height: 360, top: 20, left: 20, right: 660, bottom: 380 }
    this.visibility = 'visible'
  }
  setAttribute(name, value) { this.attributes.set(name, value) }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  getBoundingClientRect() { return this.bounds }
  set src(value) {
    this._src = value
    if (this.state.metadata !== 'pending') queueMicrotask(() => this.dispatchEvent(new Event(this.state.metadata === 'error' ? 'error' : 'loadedmetadata')))
  }
  get src() { return this._src }
  removeAttribute(name) { if (name === 'src') this._src = '' }
  pause() { this.paused = true; this.pauseCalls++ }
  play() { this.paused = false; return Promise.resolve() }
  load() { this.loadCalls++ }
}

function fixture(t, { metadata = 'ready', data = 'ready', picture = true, type = 'video/mp4' } = {}) {
  const prior = { opener: globalThis.__vaultRoomReviewOpen, languages: globalThis.__vaultRoomLanguages, location: globalThis.location, storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  const state = { metadata, data, picture, media: [], languages: [], observers: [], sources: [], created: [], revoked: [], events: [], players: [], visibilityListeners: new Set() }
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; state.observers.push(this) }
    observe(element) { this.element = element }
    disconnect() { this.disconnected = true }
    trigger() { if (!this.disconnected) this.callback([{ target: this.element }]) }
  }
  const owner = new EventTarget()
  owner.hidden = false
  owner.defaultView = { innerHeight: 800, innerWidth: 1200, IntersectionObserver: Observer,
    getComputedStyle(element) { return { visibility: element.visibility } } }
  const add = owner.addEventListener.bind(owner), remove = owner.removeEventListener.bind(owner)
  owner.addEventListener = (name, callback, options) => { if (name === 'visibilitychange') state.visibilityListeners.add(callback); add(name, callback, options) }
  owner.removeEventListener = (name, callback, options) => { if (name === 'visibilitychange') state.visibilityListeners.delete(callback); remove(name, callback, options) }
  owner.createElement = tag => { const node = new Element(tag, owner, state); if (tag === 'audio' || tag === 'video') state.media.push(node); return node }
  state.owner = owner
  state.file = () => {
    const value = { blob: new Blob(['private authenticated media']), name: 'private-media.mp4', type, closes: 0,
      close() { this.closes++; this.blob = null; state.events.push('close source') } }
    state.sources.push(value); return value
  }
  state.open = async () => state.file()
  state.player = (handlers = {}, signal) => {
    const value = createVaultRoomPlayer({ id: 'private-party' }, 'private-channel', handlers, owner, signal)
    state.players.push(value); return value
  }
  globalThis.__vaultRoomReviewOpen = options => state.open(options)
  globalThis.__vaultRoomLanguages = (media, blob, options) => {
    assert.ok(blob instanceof Blob); assert.equal(state.sources[0].blob, null, 'account keys close before track controls receive the retained blob')
    const value = { element: new Element('div', owner, state), blob, options, switching: false, disposed: 0,
      change(switching) { this.switching = switching; options.onChange({ switching }) },
      dispose() { this.disposed++; this.blob = null } }
    state.languages.push(value); return value
  }
  globalThis.location = new URL('https://rooms.example.test/#/vault')
  globalThis.localStorage = { getItem() { return 'en' } }
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); state.events.push('create URL'); const url = 'blob:private-room-' + state.created.length; state.created.push(url); return url }
  URL.revokeObjectURL = url => state.revoked.push(url)
  t.after(async () => {
    state.players.forEach(player => player.destroy()); await flush()
    globalThis.__vaultRoomReviewOpen = prior.opener; globalThis.__vaultRoomLanguages = prior.languages; globalThis.location = prior.location
    if (prior.storage) Object.defineProperty(globalThis, 'localStorage', prior.storage); else delete globalThis.localStorage
    URL.createObjectURL = prior.create; URL.revokeObjectURL = prior.revoke
  })
  return state
}

test('room playback closes a late key holder after abort without creating a plaintext URL', async t => {
  const state = fixture(t); let release, ready = 0
  state.open = () => new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const player = state.player({ onReady() { ready++ } }, controller.signal)
  controller.abort(); const late = state.file(); release(late); await flush()
  assert.equal(late.closes, 1); assert.equal(late.blob, null)
  assert.equal(ready, 0); assert.equal(state.created.length, 0); assert.equal(player.element.children.length, 0)
  assert.ok(state.observers.every(observer => observer.disconnected)); assert.equal(state.visibilityListeners.size, 0)
})

test('ready room playback drops keys before readiness and revokes only its own URL exactly once', async t => {
  const state = fixture(t); let ready = 0
  const independentDownload = URL.createObjectURL(new Blob(['an independent Vault download']))
  state.events.length = 0
  const player = state.player({ onReady() { ready++; state.events.push('ready') } })
  player.element.isConnected = true
  player.setVolume(.4, true); await flush()
  assert.equal(ready, 1); assert.deepEqual(state.events, ['create URL', 'close source', 'ready'])
  assert.equal(state.sources[0].closes, 1); assert.equal(state.sources[0].blob, null)
  assert.equal(player.privateTitle(), 'private-media.mp4'); assert.equal(player.getDuration(), 10)
  const media = state.media[0]; assert.equal(media.volume, .4); assert.equal(media.muted, true)
  await player.play(); assert.equal(media.paused, false)
  player.seek(99); assert.equal(player.getTime(), 10)
  player.destroy(); player.destroy()
  assert.deepEqual(state.revoked, [state.created[1]]); assert.equal(state.revoked.length, 1)
  assert.ok(!state.revoked.includes(independentDownload))
  assert.equal(media.src, ''); assert.equal(media.loadCalls, 1); assert.equal(media.paused, true)
  assert.equal(state.sources[0].closes, 1); assert.equal(player.privateTitle(), ''); assert.equal(player.element.children.length, 0)
})

test('viewer visibility requires a connected, visible player inside the active viewport', async t => {
  const state = fixture(t), visible = []
  const player = state.player({ onVisibility(value) { visible.push(value) } })
  await flush(); assert.equal(visible.at(-1), false, 'detached video docks must not acquire a viewing lease')
  const observer = state.observers[0], element = player.element
  element.isConnected = true; observer.trigger(); assert.equal(visible.at(-1), true)
  element.isConnected = false; observer.trigger(); assert.equal(visible.at(-1), false)
  element.isConnected = true; const original = element.bounds
  for (const bounds of [
    { ...original, width: 0 }, { ...original, height: 0 }, { ...original, bottom: -1 },
    { ...original, right: -1 }, { ...original, top: 801 }, { ...original, left: 1201 },
  ]) { element.bounds = bounds; observer.trigger(); assert.equal(visible.at(-1), false) }
  element.bounds = original; element.visibility = 'hidden'; observer.trigger(); assert.equal(visible.at(-1), false)
  element.visibility = 'visible'; observer.trigger(); assert.equal(visible.at(-1), true)
  state.owner.hidden = true; state.owner.dispatchEvent(new Event('visibilitychange')); assert.equal(visible.at(-1), false)
  state.owner.hidden = false; state.owner.dispatchEvent(new Event('visibilitychange')); assert.equal(visible.at(-1), true)
  player.destroy(); const count = visible.length
  observer.trigger(); state.owner.dispatchEvent(new Event('visibilitychange')); assert.equal(visible.length, count)
  assert.equal(state.visibilityListeners.size, 0)
})

test('rejected encrypted media never creates playback resources or ready callbacks', async t => {
  const state = fixture(t); let ready = 0, errors = 0
  state.open = async () => { throw new Error('sharing access revoked') }
  const player = state.player({ onReady() { ready++ }, onError(error) { assert.equal(error.message, 'sharing access revoked'); errors++ } })
  await flush()
  assert.equal(ready, 0); assert.equal(errors, 1); assert.equal(state.created.length, 0); assert.equal(state.media.length, 0)
  assert.equal(player.element.children[0].textContent, 'sharing access revoked')
})

test('decode failures release the owned plaintext URL and media source without double cleanup', async t => {
  const state = fixture(t, { metadata: 'error' }); let errors = 0, ready = 0
  const player = state.player({ onReady() { ready++ }, onError() { errors++ } })
  await flush()
  assert.equal(errors, 1); assert.equal(ready, 0); assert.equal(state.sources[0].closes, 1)
  assert.deepEqual(state.revoked, state.created); assert.equal(state.created.length, 1)
  assert.equal(state.media[0].src, ''); assert.equal(state.media[0].loadCalls, 1); assert.equal(state.media[0].paused, true)
  player.destroy(); assert.equal(state.revoked.length, 1); assert.equal(state.sources[0].closes, 1)
})

test('closing while metadata is pending prevents late decoder events from making the viewer ready', async t => {
  const state = fixture(t, { metadata: 'pending' }); let ready = 0, errors = 0
  const player = state.player({ onReady() { ready++ }, onError() { errors++ } })
  await flush(); player.destroy(); await flush()
  state.media[0].dispatchEvent(new Event('loadedmetadata')); await flush()
  assert.equal(ready, 0); assert.equal(errors, 0)
  assert.equal(state.sources[0].closes, 1); assert.deepEqual(state.revoked, state.created)
  assert.equal(state.media[0].src, ''); assert.equal(state.media[0].loadCalls, 1)
})

test('audio room playback uses a passive audio surface and closes its key holder immediately', async t => {
  const state = fixture(t, { type: 'audio/webm' })
  const player = state.player(); player.element.isConnected = true; await flush()
  assert.equal(state.media[0].tag, 'audio'); assert.equal(player.element.children.length, 4)
  assert.equal(state.sources[0].closes, 1); assert.equal(state.sources[0].blob, null)
  player.destroy(); assert.deepEqual(state.revoked, state.created)
})

test('room readiness waits for actual decoded data rather than container metadata alone', async t => {
  const state = fixture(t, { data: 'pending' }); let ready = 0
  const player = state.player({ onReady() { ready++ } }); await flush()
  assert.equal(ready, 0); assert.equal(state.languages.length, 0)
  state.media[0].readyState = 2; state.media[0].dispatchEvent(new Event('loadeddata')); await flush()
  assert.equal(ready, 1); assert.equal(state.languages.length, 1)
  player.destroy(); assert.equal(state.languages[0].disposed, 1); assert.equal(state.languages[0].blob, null)
})

test('a video with audio but no decodable picture cannot become a ready black player', async t => {
  const state = fixture(t, { picture: false }); let ready = 0, errors = 0
  state.player({ onReady() { ready++ }, onError(error) { errors++; assert.match(error.message, /video picture/u) } })
  await flush(); assert.equal(ready, 0); assert.equal(errors, 1); assert.equal(state.languages.length, 0)
  assert.deepEqual(state.revoked, state.created); assert.equal(state.media[0].src, '')
})

test('language changes stay local, ignore temporary decoder events and resynchronize only after switching', async t => {
  const state = fixture(t); let ready = 0, errors = 0, ended = 0
  const player = state.player({ onReady() { ready++ }, onError() { errors++ }, onEnded() { ended++ } }); await flush()
  const language = state.languages[0], media = state.media[0]; media.currentTime = 3
  language.change(true); player.seek(8); await player.play(); player.pause()
  assert.equal(player.getTime(), 3); assert.equal(media.paused, true); assert.equal(media.pauseCalls, 0)
  media.dispatchEvent(new Event('error')); media.dispatchEvent(new Event('ended'))
  assert.equal(errors, 0); assert.equal(ended, 0); assert.equal(ready, 1)
  language.change(false); assert.equal(ready, 2)
  player.seek(8); await player.play(); assert.equal(player.getTime(), 8); assert.equal(media.paused, false)
  language.options.onError?.(new Error('Track selection unavailable'))
  assert.equal(errors, 0, 'optional track selection does not invalidate ordinary room playback')
  player.destroy(); assert.equal(language.disposed, 1); assert.equal(language.blob, null)
})
