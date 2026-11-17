import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const origin = 'https://rooms.example.test'
const panel = 'chrome-extension://rooms-test/panel.html'
const video = 'M7lc1UVf-VE'
const source = panel + '#' + video
const account = '00000000-0000-4000-8000-000000000001'
const otherAccount = '00000000-0000-4000-8000-000000000002'
const topic = '00000000-0000-4000-8000-000000000003'
const channel = '00000000-0000-4000-8000-000000000004'
const roomUrl = `${origin}/#/rooms/${topic}/${channel}`
const confirmation = `${origin}/#/share/youtube/${video}`
let fixtureId = 0

async function fixture(t, { hidePanelUrl = false, reportOldPanelOnce = false, watchStatus = 200 } = {}) {
  const tabs = new Map()
  const onUpdated = new Set()
  const attempts = []
  const requests = []
  const removed = []
  let messageListener
  let onRemoved
  let nextId = 0
  let staleTab

  function tab(values = {}) {
    const data = { id: ++nextId, windowId: 1, incognito: false, cookieStoreId: 'default', status: 'complete',
      lastAccessed: nextId, url: origin + '/#/rooms', workspace: true, displayedAccount: account, sessionAccount: account, ...values }
    tabs.set(data.id, data)
    return data
  }

  const previousBrowser = globalThis.browser
  const previousFetch = globalThis.fetch
  t.after(() => {
    if (previousBrowser === undefined) delete globalThis.browser
    else globalThis.browser = previousBrowser
    globalThis.fetch = previousFetch
  })
  globalThis.fetch = async (url, options) => {
    if (options.method === 'HEAD') return new Response(null, {
      headers: { 'content-type': 'text/html', 'x-zelotez-rooms-client': '1' },
    })
    assert.equal(url.pathname, '/api/desktop/instance')
    return Response.json({ product: 'zelotez-rooms', origin, protocol: 1, nonce: url.searchParams.get('nonce') })
  }
  globalThis.browser = {
    action: { onClicked: { addListener() {} } },
    permissions: { contains: async () => true },
    storage: { local: { get: async () => ({ roomsInstance: { origin, target: 'browser' } }) } },
    runtime: { id: 'rooms-test', getURL: () => panel, onMessage: { addListener(listener) { messageListener = listener } } },
    tabs: {
      onRemoved: { addListener(listener) { onRemoved = listener } },
      onUpdated: { addListener: listener => onUpdated.add(listener), removeListener: listener => onUpdated.delete(listener) },
      create: async ({ url, windowId }) => tab({ url, windowId, workspace: false }),
      get: async id => {
        if (staleTab?.id === id) {
          const current = staleTab
          staleTab = undefined
          return current
        }
        const current = { ...tabs.get(id) }
        if (hidePanelUrl && current.url === source) delete current.url
        return current
      },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      update: async (id, changes) => {
        const current = tabs.get(id)
        if (reportOldPanelOnce && current.url === source && changes.url === origin + '/') staleTab = { ...current }
        Object.assign(current, changes)
        for (const listener of onUpdated) listener(id, changes)
        return { ...current }
      },
      remove: async id => { removed.push(id); tabs.delete(id); onRemoved(id) },
    },
    scripting: {
      async executeScript({ target, func, args }) {
        assert.deepEqual(target.frameIds, [0])
        const current = tabs.get(target.tabId)
        attempts.push([current.id, func.name])
        const location = new URL(current.url)
        const window = {}
        window.top = window
        const document = { querySelector(selector) {
          if (selector === '#workspace:not([hidden])' || selector === '#auth[hidden]') return current.workspace ? {} : null
          if (selector === '#profile-name') return { getAttribute: () => current.displayedAccount }
          if (selector === 'dialog[open]') return current.dialog ? {} : null
          throw new Error(`Unexpected selector ${selector}`)
        } }
        function fetch(url, options) {
          const withAccount = options.headers?.['X-Rooms-Account']
          requests.push({ tabId: current.id, path: url.pathname, method: options.method ?? 'GET', account: withAccount, body: options.body })
          if (withAccount && withAccount !== current.sessionAccount) return new Response(null, { status: 409 })
          if (url.pathname === '/api/auth/session') {
            current.onSession?.(location)
            return Response.json({ user: current.sessionAccount ? { id: current.sessionAccount } : null })
          }
          if (url.pathname === '/api/quick-rooms') {
            return Response.json({ publicId: topic, topicId: topic, channelId: channel, source: 'youtube', guestAccess: false, memberVisibility: false })
          }
          if (url.pathname === `/api/channels/${channel}/watch`) {
            return Response.json({ party: { videoId: video, source: 'youtube' } }, { status: watchStatus })
          }
          if (url.pathname === `/api/quick-rooms/${topic}`) return new Response(null, { status: 204 })
          throw new Error(`Unexpected request ${url}`)
        }
        const result = await runInNewContext(`(${func.toString()})(...args)`, { window, document, location, fetch, URL, AbortSignal, args })
        current.url = location.href
        return [{ result }]
      },
    },
  }
  await import(`../background.js?fixture=${fixtureId++}`)

  function message(type, tab, url = tab.url) {
    return new Promise(resolve => assert.equal(messageListener({ type }, { id: 'rooms-test', frameId: 0, tab, url }, resolve), true))
  }
  async function openHandoff() {
    const youtube = tab({ url: `https://www.youtube.com/watch?v=${video}`, workspace: false })
    assert.deepEqual(await message('rooms-youtube-video', youtube), { ok: true })
    return [...tabs.values()].find(tab => tab.url === source)
  }
  return { tab, openHandoff, launch: tab => message('rooms-browser-handoff', tab, source), attempts, requests, removed }
}

test('reuses an open same-account workspace and closes only the managed handoff tab', async t => {
  const { tab, openHandoff, launch, attempts, requests, removed } = await fixture(t, { hidePanelUrl: true, reportOldPanelOnce: true })
  const ready = tab()
  const stale = tab({ sessionAccount: otherAccount })
  const differentAccount = tab({ displayedAccount: otherAccount, sessionAccount: otherAccount })
  const locked = tab({ workspace: false })
  tab({ windowId: 2 })
  tab({ incognito: true })
  tab({ cookieStoreId: 'work' })
  tab({ url: 'https://rooms.example.test:444/#/rooms' })
  tab({ url: `${origin}/guest` })
  const handoff = await openHandoff()
  assert.deepEqual(await launch(handoff), { ok: true })
  assert.equal(ready.url, roomUrl)
  assert.equal(ready.active, true)
  assert.deepEqual(removed, [handoff.id])
  assert.deepEqual(attempts, [[handoff.id, 'readRoomsAccount'], ...[locked, differentAccount, stale, ready]
    .map(candidate => [candidate.id, 'createSignedInRoom'])])
  assert.deepEqual(requests.map(({ tabId, method, account: expected }) => [tabId, method, expected]), [
    [handoff.id, 'GET', undefined], [stale.id, 'GET', account], [ready.id, 'GET', account],
    [ready.id, 'POST', account], [ready.id, 'POST', account],
  ])
  assert.deepEqual(JSON.parse(requests[3].body), { source: 'youtube', guestAccess: false, memberVisibility: false })
  assert.deepEqual(JSON.parse(requests[4].body), { source: 'youtube', videoId: video })
})

test('a signed-in cookie alone routes the new tab to confirmation without creating a room', async t => {
  const { tab, openHandoff, launch, requests, removed } = await fixture(t)
  tab({ workspace: false })
  tab({ dialog: true })
  tab({ onSession(location) { location.hash = '#/friends' } })
  const handoff = await openHandoff()
  assert.deepEqual(await launch(handoff), { ok: true })
  assert.equal(handoff.url, confirmation)
  assert.ok(requests.every(request => request.method === 'GET'))
  assert.deepEqual(removed, [])
})

test('a partial watch start removes the incomplete room and falls back without retrying in another tab', async t => {
  const { tab, openHandoff, launch, requests, removed } = await fixture(t, { watchStatus: 503 })
  tab()
  const recent = tab()
  const handoff = await openHandoff()
  assert.deepEqual(await launch(handoff), { ok: true })
  assert.equal(handoff.url, confirmation)
  assert.deepEqual(requests.filter(request => request.method !== 'GET').map(({ tabId, method, account: expected }) => [tabId, method, expected]), [
    [recent.id, 'POST', account], [recent.id, 'POST', account], [recent.id, 'DELETE', account],
  ])
  assert.deepEqual(removed, [])
})
