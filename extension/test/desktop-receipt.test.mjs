import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopHandoff, handoffId, waitForDesktopReceipt } from '../links.mjs'

const origin = 'https://rooms.example.test'
const video = 'M7lc1UVf-VE'
const audience = { guestAccess: false, memberVisibility: true }

test('desktop links carry a fresh optional handoff ID and keep the legacy link valid', () => {
  const receipt = handoffId()
  assert.match(receipt, /^[a-f0-9]{32}$/u)
  assert.notEqual(receipt, handoffId())
  const legacy = new URL(desktopHandoff(origin, video, audience))
  assert.deepEqual([...legacy.searchParams], [['instance', origin], ['guests', '0'], ['live', '1']])
  const current = new URL(desktopHandoff(origin, video, audience, receipt))
  assert.deepEqual([...current.searchParams], [...legacy.searchParams, ['handoff', receipt]])
  assert.throws(() => desktopHandoff(origin, video, audience, receipt + '\n'))
})

test('desktop confirmation uses only a receipt ID and the checked origin', async t => {
  const receipt = handoffId()
  const active = new AbortController()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, origin + '/api/desktop/handoff')
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.deepEqual(JSON.parse(options.body), { id: receipt, action: 'status' })
    return new Response(null, { status: 204 })
  })
  assert.equal(await waitForDesktopReceipt(origin, receipt, active.signal), true)
})

test('a canceled handoff ignores a receipt and an unavailable endpoint returns to the fallback', async t => {
  const receipt = handoffId()
  const attempt = new AbortController()
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    attempt.abort()
    return new Response(null, { status: 204 })
  })
  assert.equal(await waitForDesktopReceipt(origin, receipt, attempt.signal), false)
  fetch.mock.mockImplementation(async () => new Response(null, { status: 404 }))
  assert.equal(await waitForDesktopReceipt(origin, receipt, new AbortController().signal), false)
})
