import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDesktopHandoff } from '../desktop-handoff.mjs'

const first = 'a'.repeat(32)
const second = 'b'.repeat(32)
const third = 'c'.repeat(32)

function fixture(t, maximum) {
  let time = 0
  const handoff = createDesktopHandoff({ now: () => time, maximum })
  t.after(handoff.close)

  async function request(body, { method = 'POST', url = '/api/desktop/handoff', contentType = 'application/json' } = {}) {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const input = Object.assign(Readable.from([bytes]), { method, url, headers: { 'content-type': contentType } })
    let result
    const output = {
      writeHead(status, headers) {
        result = { status, headers }
        return this
      },
      end(data) { assert.equal(data, undefined) },
    }
    await handoff.handle(input, output)
    return result
  }

  return { request, tick(ms) { time += ms } }
}

test('desktop handoff status is private to its ID and repeat reports never extend the receipt', async t => {
  const { request, tick } = fixture(t)
  assert.equal((await request({ id: first, action: 'status' })).status, 202)
  assert.equal((await request({ id: first, action: 'opened' })).status, 204)
  assert.equal((await request({ id: second, action: 'status' })).status, 202)
  tick(89_999)
  assert.equal((await request({ action: 'opened', id: first })).status, 204)
  assert.equal((await request({ id: first, action: 'status' })).status, 204)
  tick(1)
  assert.equal((await request({ id: first, action: 'status' })).status, 202)
})

test('desktop handoff pending checks take no storage and capacity preserves existing receipts', async t => {
  const { request, tick } = fixture(t, 2)
  assert.equal((await request({ id: third, action: 'status' })).status, 202)
  assert.equal((await request({ id: first, action: 'opened' })).status, 204)
  tick(1000)
  assert.equal((await request({ id: second, action: 'opened' })).status, 204)
  assert.equal((await request({ id: third, action: 'opened' })).status, 429)
  assert.equal((await request({ id: second, action: 'status' })).status, 204)
  tick(89_000)
  assert.equal((await request({ id: third, action: 'opened' })).status, 204)
  assert.equal((await request({ id: second, action: 'status' })).status, 204)
  assert.equal((await request({ id: first, action: 'status' })).status, 202)
})

test('desktop handoff rejects unexpected methods, query strings and invalid or oversized payloads', async t => {
  const { request } = fixture(t)
  const body = { id: first, action: 'opened' }
  assert.deepEqual(await request(body, { method: 'GET' }), { status: 405, headers: { Allow: 'POST' } })
  assert.equal((await request(body, { url: '/api/desktop/handoff?extra=1' })).status, 400)
  await assert.rejects(request(body, { contentType: 'text/plain' }), { status: 415 })
  for (const invalid of [
    null, 'not JSON', [first, 'opened'], { id: first.slice(1), action: 'opened' },
    { id: first + '\n', action: 'opened' }, { id: first.toUpperCase(), action: 'opened' },
    { id: first, action: ['opened'] }, { id: first, action: 'prepare' }, { id: first },
    { ...body, extra: true },
  ]) await assert.rejects(request(invalid), { status: 400 })
  await assert.rejects(request(JSON.stringify(body) + ' '.repeat(81)), { status: 413 })
  assert.equal((await request({ id: first, action: 'status' })).status, 202)
})
