import assert from 'node:assert/strict'
import test from 'node:test'
import { createVaultExplorerModel, navigateVaultExplorer, vaultExplorerView, validateVaultExplorerMove,
  VAULT_EXPLORER_ROOT as ROOT, VAULT_EXPLORER_SHARED as SHARED } from '../../web/vault-explorer-model.js'

const own = (id, parentId = null, kind = 'folder', extra = {}) => ({ id, ownerId: 'me', parentId, kind,
  state: 'ready', name: id, ...extra })
const received = (shareId, entryId, ownerId = 'sender-a', extra = {}) => ({ id: entryId,
  ownerId, parentId: null, kind: 'file', state: 'ready', name: entryId,
  receivedShareId: shareId, uiId: 'share:' + shareId,
  share: { id: shareId, entryId, ownerId, recipientId: 'me',
    owner: { id: ownerId, username: 'same-user', displayName: 'Display Name' } }, ...extra })
const model = (entries = [], receivedEntries = [], options = {}) =>
  createVaultExplorerModel({ entries, receivedEntries }, { actorId: 'me', ...options })
const move = (m, from, to, actorId = 'me') => validateVaultExplorerMove(m, from, to, { actorId })

test('empty root always contains the labelled, read-only Shared folder', () => {
  const m = model([], [], { rootName: 'Dateien', sharedName: 'Mit mir geteilt' })
  assert.deepEqual(m.children(ROOT).map(n => n.ref), [SHARED])
  assert.equal(m.node(ROOT).name, 'Dateien')
  assert.equal(m.node(SHARED).name, 'Mit mir geteilt')
  assert.equal(m.node(SHARED).synthetic, true)
  assert.equal(m.node(SHARED).readOnly, true)
  assert.equal(m.node(SHARED).entry, null)
  assert.deepEqual(vaultExplorerView(m).path, [ROOT])
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.children(ROOT)))
})

test('sender IDs separate duplicate usernames and names cannot collide with virtual folders', () => {
  const a = received('share-a', 'file'), b = received('share-b', 'file', 'sender-b')
  const c = received('share-c', 'file')
  const entry = own('shared', null, 'folder', { name: 'Shared With Me' })
  const m = model([entry, own('file', null, 'file')], [a, b, c])
  assert.deepEqual(m.children(SHARED).map(n => n.ref).sort(), ['sender:sender-a', 'sender:sender-b'])
  assert.equal(m.node('sender:sender-a').name, 'same-user')
  assert.equal(m.node('sender:sender-b').name, 'same-user')
  assert.deepEqual(m.children('sender:sender-a').map(n => n.ref).sort(), ['share:share-a', 'share:share-c'])
  assert.equal(m.node('own:shared').entry, entry)
  assert.notEqual(m.node('own:file'), m.node('share:share-a'))
  assert.equal(m.node('share:share-a').entry, a)
  assert.equal(m.node('share:share-a').entry.receivedShareId, 'share-a')
})

test('sender label prefers username, falls back to display name and groups missing identities safely', () => {
  const a = received('a', 'f1'), b = received('b', 'f2', 'sender-b'), c = received('c', 'f3', 'sender-c')
  b.share.owner.username = ''
  c.share.owner = undefined
  const m = model([], [a, b, c], { unknownSenderName: 'Unbekannt' })
  assert.equal(m.node('sender:sender-a').name, 'same-user')
  assert.equal(m.node('sender:sender-b').name, 'Display Name')
  assert.equal(m.node('unknown-sender').name, 'Unbekannt')
  assert.equal(m.node('share:c').parentRef, 'unknown-sender')
  assert.equal(m.node('share:c').locked, true)
  assert.equal(m.node('share:c').entry.receivedShareId, 'c')
})

test('inconsistent received capabilities are always locked and read-only', () => {
  const a = received('a', 'f1'), b = received('b', 'f2')
  a.share.recipientId = 'someone-else'; b.share.entryId = 'different-file'
  const m = model([], [a, b])
  for (const ref of ['share:a', 'share:b']) {
    assert.equal(m.node(ref).locked, true)
    assert.equal(m.node(ref).readOnly, true)
    assert.equal(move(m, ref, ROOT).ok, false)
  }
})

test('duplicate IDs are not resolved arbitrarily and prototype-like IDs remain ordinary references', () => {
  const m = model([own('duplicate'), own('duplicate'), own('__proto__')],
    [received('duplicate', 'a'), received('duplicate', 'b')])
  assert.equal(m.node('own:duplicate'), null)
  assert.equal(m.node('share:duplicate'), null)
  assert.equal(m.node('own:__proto__').entry.id, '__proto__')
  assert.deepEqual(m.path('own:__proto__').map(n => n.ref), [ROOT, 'own:__proto__'])
})

test('listing sorts folders first and numeric file names naturally without modifying the snapshot', () => {
  const entries = [own('10', null, 'file'), own('2', null, 'file'), own('z', null, 'folder')]
  const m = model(entries)
  assert.deepEqual(m.children(ROOT).map(n => n.ref), [SHARED, 'own:z', 'own:2', 'own:10'])
  assert.deepEqual(entries.map(n => n.id), ['10', '2', 'z'])
})

test('full breadcrumbs retain deep paths while visible columns preserve the first three panels', () => {
  const m = model([own('a'), own('b', 'a'), own('c', 'b'), own('d', 'c'), own('e', 'd')])
  const nav = navigateVaultExplorer(m, [], 'own:e')
  assert.deepEqual(nav, [ROOT, 'own:a', 'own:b', 'own:c', 'own:d', 'own:e'])
  const view = vaultExplorerView(m, nav)
  assert.deepEqual(view.breadcrumbs.map(n => n.ref), nav)
  assert.deepEqual(view.columns.map(n => n.ref), [ROOT, 'own:a', 'own:b', 'own:e'])
  assert.deepEqual(view.columns.map(n => n.selectedRef), ['own:a', 'own:b', 'own:c', null])
  assert.equal(view.selected.ref, 'own:e')
  assert.equal(view.columns[2].node, m.node('own:b'))
  assert.ok(Object.isFrozen(view.path) && Object.isFrozen(view.columns))
})

test('file selection does not truncate or navigate the independent folder panels', () => {
  const m = model([own('a'), own('b', 'a'), own('file', 'a', 'file')])
  const nav = [ROOT, 'own:a', 'own:b']
  assert.deepEqual(navigateVaultExplorer(m, nav, 'own:file'), nav)
  assert.deepEqual(m.path('own:file').map(n => n.ref), [ROOT, 'own:a', 'own:file'])
  assert.deepEqual(vaultExplorerView(m, [...nav, 'own:file']).path, nav)
})

test('virtual Shared navigation is part of the same canonical root path', () => {
  const m = model([], [received('a', 'file')])
  const nav = navigateVaultExplorer(m, ['own:stale'], 'sender:sender-a')
  assert.deepEqual(nav, [ROOT, SHARED, 'sender:sender-a'])
  assert.deepEqual(m.path('share:a').map(n => n.ref), [...nav, 'share:a'])
  assert.deepEqual(vaultExplorerView(m, nav).columns.map(n => n.ref), nav)
})

test('refresh follows the actual path of an existing moved folder, retaining stable references', () => {
  const before = model([own('a'), own('b', 'a'), own('other')])
  const nav = navigateVaultExplorer(before, [], 'own:b')
  const after = model([own('a'), own('b', 'other', 'folder', { name: 'Renamed' }), own('other')])
  assert.deepEqual(vaultExplorerView(after, nav).path, [ROOT, 'own:other', 'own:b'])
  assert.equal(vaultExplorerView(after, nav).breadcrumbs.at(-1).name, 'Renamed')
})

test('deleted or newly locked folders fall back to the nearest surviving navigable ancestor', () => {
  const nav = [ROOT, 'own:a', 'own:b', 'own:c']
  const deleted = model([own('a'), own('b', 'a')])
  assert.deepEqual(vaultExplorerView(deleted, nav).path, [ROOT, 'own:a', 'own:b'])
  const locked = model([own('a'), own('b', 'a', 'folder', { locked: true }), own('c', 'b')])
  assert.deepEqual(vaultExplorerView(locked, nav).path, [ROOT, 'own:a'])
  assert.deepEqual(vaultExplorerView(deleted, null).path, [ROOT])
})

test('cycles, self-parenting, file parents and missing parents cannot produce fictitious paths', () => {
  const m = model([own('a', 'b'), own('b', 'a'), own('self', 'self'), own('orphan', 'absent'),
    own('file', null, 'file'), own('child', 'file')])
  for (const ref of ['own:a', 'own:b', 'own:self', 'own:orphan', 'own:child']) {
    assert.deepEqual(m.path(ref), [])
    assert.deepEqual(navigateVaultExplorer(m, [], ref), [ROOT])
    assert.equal(move(m, ref, ROOT).ok, false)
  }
  assert.deepEqual(m.children(ROOT).map(n => n.ref), [SHARED, 'own:file'])
})

test('moves resolve canonical records and return the existing client entry without mutation', () => {
  const file = own('file', 'a', 'file'), a = own('a'), b = own('b')
  const m = model([a, b, file])
  assert.deepEqual(move(m, 'own:file', 'own:b'), { ok: true, reason: null, entry: file, parentId: 'b' })
  assert.deepEqual(move(m, 'own:file', ROOT), { ok: true, reason: null, entry: file, parentId: null })
  assert.equal(file.parentId, 'a')
  assert.equal(move(m, { ref: 'own:file', ownerId: 'me' }, ROOT).reason, 'source-unavailable')
})

test('moves reject account switches, omitted current actor and foreign snapshot ownership', () => {
  const foreign = own('foreign', null, 'file', { ownerId: 'other' })
  const m = model([own('a'), own('file', 'a', 'file'), foreign])
  assert.equal(move(m, 'own:file', ROOT, 'other').reason, 'actor-changed')
  assert.equal(validateVaultExplorerMove(m, 'own:file', ROOT).reason, 'actor-changed')
  assert.equal(move(m, 'own:foreign', 'own:a').reason, 'read-only')
  assert.equal(m.node('own:foreign').locked, true)
})

test('synthetic nodes and received files can never become move sources or own destinations', () => {
  const m = model([own('file', null, 'file'), own('folder')], [received('a', 'file')])
  for (const source of [ROOT, SHARED, 'sender:sender-a', 'share:a']) {
    assert.equal(move(m, source, 'own:folder').ok, false)
  }
  for (const destination of [SHARED, 'sender:sender-a', 'share:a', 'own:file', 'own:absent']) {
    assert.equal(move(m, 'own:file', destination).ok, false)
  }
})

test('locked and pending sources or destinations are not valid drag operations', () => {
  const m = model([own('a'), own('file', 'a', 'file'), own('locked', null, 'folder', { locked: true }),
    own('locked-file', null, 'file', { locked: true }), own('pending', null, 'file', { state: 'uploading' }),
    own('pending-folder', null, 'folder', { state: 'uploading' })])
  for (const source of ['own:locked', 'own:locked-file', 'own:pending']) assert.equal(move(m, source, 'own:a').ok, false)
  for (const destination of ['own:locked', 'own:pending-folder']) assert.equal(move(m, 'own:file', destination).ok, false)
  assert.ok(!m.children(ROOT).some(n => n.ref === 'own:pending'))
  assert.deepEqual(navigateVaultExplorer(m, [], 'own:pending-folder'), [ROOT])
})

test('self, descendant and unchanged-parent moves are rejected', () => {
  const m = model([own('a'), own('b', 'a'), own('c', 'b'), own('file', 'b', 'file')])
  assert.equal(move(m, 'own:a', 'own:a').reason, 'self')
  assert.equal(move(m, 'own:a', 'own:c').reason, 'cycle')
  assert.equal(move(m, 'own:file', 'own:b').reason, 'same-parent')
  assert.equal(move(m, 'own:a', ROOT).reason, 'same-parent')
})

test('server depth limit includes the complete moved subtree and in-progress children', () => {
  const entries = Array.from({ length: 31 }, (_, i) => own('d' + i, i ? 'd' + (i - 1) : null))
  entries.push(own('source'), own('child', 'source', 'file', { state: 'uploading' }), own('file', null, 'file'))
  const m = model(entries)
  assert.equal(move(m, 'own:file', 'own:d30').ok, true)
  assert.equal(move(m, 'own:source', 'own:d30').reason, 'too-deep')
  assert.equal(m.children('own:source').length, 0)
  assert.equal(m.children('own:source', { includeUploading: true }).length, 1)
  const max = model([...entries, own('d31', 'd30')])
  assert.equal(move(max, 'own:file', 'own:d31').reason, 'too-deep')
  assert.deepEqual(max.path('own:d31').map(n => n.ref).slice(0, 3), [ROOT, 'own:d0', 'own:d1'])
})

test('too-deep corrupted paths terminate and navigation keeps the last valid ancestor', () => {
  const entries = Array.from({ length: 40 }, (_, i) => own('d' + i, i ? 'd' + (i - 1) : null))
  const m = model(entries)
  assert.deepEqual(m.path('own:d39'), [])
  const nav = [ROOT, ...entries.map(n => 'own:' + n.id)]
  assert.equal(vaultExplorerView(m, nav).selected.ref, 'own:d31')
  const broken = model([own('holder'), own('target'), ...entries.map(n => n.id === 'd0' ? { ...n, parentId: 'holder' } : n)])
  assert.equal(move(broken, 'own:d0', 'own:target').reason, 'invalid-tree')
})

test('mutation validation rechecks raw record ownership, state, capability and parent after model creation', () => {
  for (const change of [entry => { entry.ownerId = 'other' }, entry => { entry.state = 'uploading' },
    entry => { entry.receivedShareId = 'injected' }, entry => { entry.parentId = 'other-folder' },
    entry => { entry.id = 'changed' }, entry => { entry.kind = 'folder' }, entry => { entry.locked = true }]) {
    const source = own('file', 'a', 'file'), m = model([own('a'), own('destination'), source])
    change(source)
    assert.equal(move(m, 'own:file', 'own:destination').ok, false)
  }
  const destination = own('destination'), m = model([own('a'), own('file', 'a', 'file'), destination])
  destination.ownerId = 'other'
  assert.equal(move(m, 'own:file', 'own:destination').ok, false)
})

test('mutation validation also rechecks ancestors and hidden subtree identities', () => {
  const ancestor = own('ancestor'), destination = own('destination', 'ancestor')
  const m = model([ancestor, destination, own('file', null, 'file')])
  ancestor.ownerId = 'another-account'
  assert.equal(move(m, 'own:file', 'own:destination').ok, false)
  const child = own('pending', 'folder', 'file', { state: 'uploading' })
  const m2 = model([own('folder'), own('target'), child])
  child.receivedShareId = 'unexpected-capability'
  assert.equal(move(m2, 'own:folder', 'own:target').reason, 'invalid-tree')
})

test('received records with missing entry identity remain visible but locked', () => {
  const item = received('bad', undefined)
  const m = model([], [item])
  assert.equal(m.node('share:bad').locked, true)
  assert.equal(m.children('sender:sender-a').length, 1)
})
