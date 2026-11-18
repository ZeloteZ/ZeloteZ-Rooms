import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext } from 'node:vm'
import test from 'node:test'

const app = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8')
function actualFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app)
  assert.ok(match, `Missing application function ${name}`)
  const end = app.indexOf('\n}\n', match.index)
  assert.ok(end > match.index, `Missing application function end ${name}`)
  return app.slice(match.index, end + 2)
}
// Execute the application functions themselves. Only browser surfaces, page
// builders and the editor's deferred confirmation boundary are substituted.
const script = new Script(['render', 'enterAuth', 'lockOnAccountChange'].map(actualFunction).join('\n'),
  { filename: 'web/app.js:navigation-regression' })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const decision = deferred()
  const state = { calls: [], replacements: [], hashes: [], headers: [], leaveCalls: 0,
    viewAborts: 0, cryptoLocks: 0, keyWipes: 0, authCalls: [], discards: 0, builders: new Map() }
  const workspace = { hidden: false, scrollTop: 0, children: [], contains: () => false,
    replaceChildren(...children) { this.children = children; state.replacements.push(children) } }
  const roomHeader = { contains: () => false, querySelector: () => null }
  const location = { hash: '#/vault' }
  const canLeave = () => { state.leaveCalls++; return decision.promise }
  const page = (name, context) => {
    state.calls.push({ name, signal: context?.signal, account: context?.user })
    return state.builders.has(name) ? state.builders.get(name).promise : { page: name }
  }
  const scope = createContext({
    AbortController,
    user: { id: 'original-account', admin: false },
    pageLeave: null, renderedHash: null, renderGeneration: 0, view: null, activeTopic: null,
    desktop: false, vaultLocked: false, location, workspace, roomHeader,
    document: { activeElement: null },
    history: { state: { preserved: true }, replaceState(value, _title, hash) {
      assert.deepEqual(value, { preserved: true })
      state.hashes.push(hash); location.hash = hash
    } },
    getRoute() {
      const [name, topicId] = location.hash.slice(2).split('/')
      return { page: name || 'rooms', topicId }
    },
    quickRoomHeader: { setLocation() {} },
    player: { setLocation() {}, refreshPlacement() {} },
    voice: { setLocation() {} }, videoDock: { refreshPlacement() {} },
    screenShare: {}, nativeBroadcast: {}, profileUpdates: {}, tutorials: {},
    setNav() {}, showTutorial() {},
    setRoomHeader(...values) { state.headers.push(values) },
    roomIdPattern: /^[a-f0-9-]{36}$/u,
    t: value => value,
    el: (tag, attributes, ...children) => ({ tag, attributes, children }),
    button: (label, action) => ({ label, action }),
    renderVault(context) { return { node: page('vault', context), header: { vaultHeader: true }, canLeave } },
    renderTopics: context => page('rooms', context),
    renderFriends: context => page('friends', context),
    renderDirect: context => page('direct', context),
    renderDownloads: context => page('downloads', context),
    renderHowItWorks: () => page('help'),
    changePassword() {}, openAccountSecurity() {}, confirmYoutubeRoom() {},
    api() { throw new Error('Unexpected network request in navigation fixture') },
    clearQuickLinks() {}, forgetMemberQuickChatDevices: async () => {},
    window: {}, workspaceSession: new AbortController(),
    setVideoStatsEnabled() {}, setExpectedAccount() {}, closeDialog() {},
    ClubCrypto: { lock() { state.cryptoLocks++ } },
    clearVaultKeys() { state.keyWipes++ },
    bootstrap: {}, profile: {}, navigation: {}, auth: {},
    desktopLogin: { async discard() { state.discards++ } },
  })
  scope.showAuth = (...args) => { state.authCalls.push(args); scope.enterAuth() }
  script.runInContext(scope)
  await scope.render(true)
  assert.equal(scope.pageLeave, canLeave)
  assert.equal(scope.renderedHash, '#/vault')
  assert.equal(workspace.children[0].page, 'vault')
  const originalView = scope.view
  originalView.signal.addEventListener('abort', () => { state.viewAborts++ }, { once: true })
  state.calls.length = 0; state.replacements.length = 0; state.headers.length = 0
  return { scope, state, decision, workspace, location, originalView,
    navigate(hash) { location.hash = hash; return scope.render() } }
}

test('Dirty Vault plus Home Cancel keeps the original view and restores its URL without abort', async () => {
  const f = await fixture()
  const pending = f.navigate('#/rooms')
  assert.equal(f.state.leaveCalls, 1)
  assert.equal(f.state.viewAborts, 0)
  assert.equal(f.state.calls.length, 0)
  f.decision.resolve(false)
  await pending
  assert.equal(f.scope.view, f.originalView)
  assert.equal(f.state.viewAborts, 0)
  assert.deepEqual(f.state.hashes, ['#/vault'])
  assert.equal(f.location.hash, '#/vault')
  assert.equal(f.workspace.children[0].page, 'vault')
  assert.equal(f.state.replacements.length, 0)
})

test('Dirty Vault plus Home Accept aborts exactly once and mounts the target once', async () => {
  const f = await fixture()
  const pending = f.navigate('#/rooms')
  f.decision.resolve(true)
  await pending
  assert.equal(f.state.viewAborts, 1)
  assert.equal(f.originalView.signal.aborted, true)
  assert.notEqual(f.scope.view, f.originalView)
  assert.deepEqual(f.state.calls.map(call => call.name), ['rooms'])
  assert.equal(f.workspace.children[0].page, 'rooms')
  assert.equal(f.scope.renderedHash, '#/rooms')
  assert.deepEqual(f.state.hashes, [])
})

test('two fast route requests share the decision and only the latest accepted target renders', async () => {
  const f = await fixture()
  const home = f.navigate('#/rooms'), friends = f.navigate('#/friends')
  assert.equal(f.state.leaveCalls, 2)
  f.decision.resolve(true)
  await Promise.all([home, friends])
  assert.equal(f.state.viewAborts, 1)
  assert.deepEqual(f.state.calls.map(call => call.name), ['friends'])
  assert.equal(f.workspace.children[0].page, 'friends')
  assert.equal(f.scope.renderedHash, '#/friends')
  assert.deepEqual(f.state.hashes, [])
})

test('two fast cancelled route requests restore the old Vault URL only once', async () => {
  const f = await fixture()
  const home = f.navigate('#/rooms'), friends = f.navigate('#/friends')
  f.decision.resolve(false)
  await Promise.all([home, friends])
  assert.equal(f.state.viewAborts, 0)
  assert.equal(f.state.calls.length, 0)
  assert.deepEqual(f.state.hashes, ['#/vault'])
  assert.equal(f.scope.view, f.originalView)
})

test('Home followed by browser Back uses the latest Vault target after acceptance', async () => {
  const f = await fixture()
  const home = f.navigate('#/rooms'), back = f.navigate('#/vault')
  f.decision.resolve(true)
  await Promise.all([home, back])
  assert.equal(f.state.viewAborts, 1)
  assert.deepEqual(f.state.calls.map(call => call.name), ['vault'])
  assert.equal(f.workspace.children[0].page, 'vault')
  assert.equal(f.scope.renderedHash, '#/vault')
})

for (const end of ['session', 'account']) for (const accepted of [false, true]) {
  test(`late ${accepted ? 'Accept' : 'Cancel'} after ${end} end cannot restore a hash or reopen a page`, async () => {
    const f = await fixture()
    const pending = f.navigate('#/rooms')
    if (end === 'account') f.scope.lockOnAccountChange()
    else f.scope.enterAuth()
    assert.equal(f.scope.user, null)
    assert.equal(f.scope.view, null)
    assert.equal(f.scope.pageLeave, null)
    assert.equal(f.scope.renderedHash, null)
    assert.equal(f.state.viewAborts, 1)
    assert.equal(f.state.cryptoLocks, 1)
    assert.equal(f.state.keyWipes, 1)
    assert.equal(f.workspace.hidden, true)
    assert.equal(f.workspace.children.length, 0)
    const mutationsAtEnd = f.state.replacements.length
    f.decision.resolve(accepted)
    await pending
    assert.equal(f.state.replacements.length, mutationsAtEnd)
    assert.equal(f.state.calls.length, 0)
    assert.deepEqual(f.state.hashes, [])
    assert.equal(f.location.hash, '#/rooms')
    assert.equal(f.scope.view, null)
    if (end === 'account') assert.equal(f.state.authCalls.length, 1)
  })
}

test('account identity replacement also invalidates an outstanding route decision', async () => {
  const f = await fixture()
  const pending = f.navigate('#/friends')
  f.scope.user = { id: 'other-account', admin: false }
  f.decision.resolve(true)
  await pending
  assert.equal(f.state.calls.length, 0)
  assert.equal(f.state.viewAborts, 0)
  assert.deepEqual(f.state.hashes, [])
})

test('an already allowed slow page cannot overwrite a newer completed route', async () => {
  const f = await fixture(), slow = deferred()
  f.state.builders.set('friends', slow)
  f.decision.resolve(true)
  const first = f.navigate('#/friends')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.state.calls.map(call => call.name), ['friends'])
  const slowSignal = f.state.calls[0].signal
  await f.navigate('#/help')
  assert.equal(slowSignal.aborted, true)
  assert.equal(f.workspace.children[0].page, 'help')
  const mutationsAfterHelp = f.state.replacements.length
  slow.resolve({ page: 'friends' })
  await first
  assert.equal(f.workspace.children[0].page, 'help')
  assert.equal(f.state.replacements.length, mutationsAfterHelp)
  assert.equal(f.scope.renderedHash, '#/help')
})
