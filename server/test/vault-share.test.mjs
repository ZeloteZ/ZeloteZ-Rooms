import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.document = { querySelector() { return null }, documentElement: { lang: 'en' } }
globalThis.location = new URL('https://rooms.example.test/vault')
globalThis.localStorage = { getItem() { return null } }
const { createPublicVaultSession } = await import('../../web/vault-share.js')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function file(name) {
  return { opened: { name, secret: {} }, closeCount: 0, close() { this.closeCount++ },
    prepareDownload: () => Promise.resolve({}), download: async () => {} }
}
function fixture() {
  const events = [], opens = [], destroyed = []
  let capability = { id: 'first' }, clearCount = 0
  const session = createPublicVaultSession({
    takeLink() { events.push('consume:' + (capability?.id ?? 'invalid')); return capability },
    openLink(link, options) { events.push('open:' + link.id); const wait = deferred(); opens.push({ ...wait, link, signal: options.signal }); return wait.promise },
    onState(view) { events.push('paint:' + (view?.file?.opened.name ?? view?.error ?? (view?.opening ? 'opening' : 'disposed'))) },
    clearKeys() { clearCount++ }, destroyKey(secret) { destroyed.push(secret) },
  })
  return { session, events, opens, destroyed, capability: value => { capability = value }, clearCount: () => clearCount }
}

test('a replacement fragment is consumed first and aborts a pending old opening', async () => {
  const f = fixture()
  const old = f.session.load()
  f.capability({ id: 'second' })
  const current = f.session.load()
  assert.equal(f.opens[0].signal.aborted, true)
  assert.deepEqual(f.events.slice(0, 3), ['consume:first', 'paint:opening', 'open:first'])
  assert.deepEqual(f.events.slice(3, 6), ['consume:second', 'paint:opening', 'open:second'])
  const second = file('second.txt'); f.opens[1].resolve(second); await current
  const first = file('first.txt'); f.opens[0].resolve(first); await old
  assert.equal(f.session.getState().file, second)
  assert.deepEqual(f.destroyed, [first.opened.secret])
  assert.equal(first.closeCount, 0, 'a late unopened result must not revoke the new view’s blob URLs')
  assert.equal(second.closeCount, 0)
  assert.ok(!f.events.includes('paint:first.txt'))
  f.session.dispose()
})

test('a new link closes the old file and cancels its active download', async () => {
  const f = fixture(), old = file('old.txt'), wait = deferred()
  let oldTransfer
  old.download = options => { oldTransfer = options.signal; return wait.promise }
  const opening = f.session.load(); f.opens[0].resolve(old); await opening
  const downloading = f.session.download()
  assert.equal(f.session.getState().downloading, true)
  f.capability({ id: 'new' }); const nextOpening = f.session.load()
  assert.equal(old.closeCount, 1)
  assert.equal(oldTransfer.aborted, true)
  const fresh = file('new.txt'); f.opens[1].resolve(fresh); await nextOpening
  wait.resolve(); await downloading
  assert.equal(f.session.getState().file, fresh)
  assert.equal(f.session.getState().downloadNote, null)
  f.session.dispose()
})

test('old progress and finally callbacks cannot alter the new download or its controller', async () => {
  const f = fixture(), first = file('first'), firstWait = deferred(), secondWait = deferred()
  let oldOptions
  first.download = options => { oldOptions = options; return firstWait.promise }
  const firstOpening = f.session.load(); f.opens[0].resolve(first); await firstOpening
  const firstDownload = f.session.download()
  f.capability({ id: 'second' }); const secondOpening = f.session.load()
  const second = file('second'); second.download = () => secondWait.promise
  f.opens[1].resolve(second); await secondOpening
  const secondDownload = f.session.download()
  const state = f.session.getState(), currentTransfer = state.activeDownload
  oldOptions.onProgress({ done: 9999, total: 10000 })
  firstWait.reject(new Error('late failure')); await firstDownload
  assert.equal(f.session.getState(), state)
  assert.equal(state.activeDownload, currentTransfer)
  assert.equal(state.downloading, true)
  assert.equal(state.downloadNote, 'working')
  assert.deepEqual(state.progress, { done: 0, total: 1 })
  secondWait.resolve(); await secondDownload
  assert.equal(state.downloading, false)
  assert.equal(state.downloadNote, 'complete')
  f.session.dispose()
})

test('malformed replacement links clear old keys and cannot leave an old file accessible', async () => {
  const f = fixture(), old = file('old')
  const opening = f.session.load(); f.opens[0].resolve(old); await opening
  f.capability(null); await f.session.load()
  assert.equal(old.closeCount, 1)
  assert.equal(f.session.getState().file, null)
  assert.equal(f.session.getState().error, 'invalid')
  assert.equal(f.opens.length, 1)
  assert.equal(f.clearCount(), 2)
  f.session.dispose()
})

test('page cleanup aborts pending work and a late result only destroys its own key', async () => {
  const f = fixture(), loading = f.session.load()
  f.session.dispose()
  assert.equal(f.opens[0].signal.aborted, true)
  assert.equal(f.session.getState(), null)
  const late = file('late'); f.opens[0].resolve(late); await loading
  assert.deepEqual(f.destroyed, [late.opened.secret])
  assert.equal(f.events.at(-1), 'paint:disposed')
  await f.session.load()
  assert.equal(f.opens.length, 1)
})

test('save picker preparation stays synchronous in the initiating download action', async () => {
  const f = fixture(), target = file('save')
  const opening = f.session.load(); f.opens[0].resolve(target); await opening
  const order = []
  target.prepareDownload = () => { order.push('picker'); return Promise.resolve({}) }
  target.download = async () => { order.push('download') }
  const downloading = f.session.download(); order.push('handler-returned')
  assert.deepEqual(order, ['picker', 'download', 'handler-returned'])
  await downloading; f.session.dispose()
})
