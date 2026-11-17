import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createAuthWork } from '../auth-work.mjs'

function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    headers: new Map(),
    setHeader(name, value) { this.headers.set(name, value) },
    close() {
      this.destroyed = true
      this.emit('close')
    },
  })
}

test('password work is shared between eligible logins and registrations', async () => {
  const run = createAuthWork()
  const release = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()]
  const started = []
  const schedule = (lane, ip, subject, fixedWork, reply = response()) => run({ lane, ip, subject, response: reply }, () => {
    started.push(subject)
    return fixedWork?.promise ?? subject
  })

  const first = schedule('login', 'first-ip', 'alice', release[0])
  const second = schedule('login', 'second-ip', 'bob', release[1])
  const next = schedule('login', 'third-ip', 'carol')
  const invited = schedule('registration', 'first-ip', 'invite', release[2])

  const limited = response()
  await assert.rejects(schedule('login', 'first-ip', 'another-name', undefined, limited), { status: 503 })
  assert.equal(limited.headers.get('Retry-After'), '1')
  await assert.rejects(schedule('login', 'fourth-ip', 'alice'), { status: 503 })
  await assert.rejects(schedule('registration', 'fourth-ip', 'invite'), { status: 503 })
  assert.deepEqual(started, ['alice', 'bob'])

  release[0].resolve('first')
  assert.equal(await first, 'first')
  assert.deepEqual(started, ['alice', 'bob', 'invite'])
  release[1].resolve('second')
  assert.equal(await second, 'second')
  assert.equal(await next, 'carol')
  assert.deepEqual(started, ['alice', 'bob', 'invite', 'carol'])
  release[2].resolve('new account')
  assert.equal(await invited, 'new account')
  assert.equal(await schedule('login', 'first-ip', 'alice'), 'alice')
})

test('password work drops disconnected and expired waiters and caps pending work', async () => {
  const run = createAuthWork({ waitMs: 40 })
  const release = Promise.withResolvers()
  const schedule = (number, reply, work) => run({
    lane: 'login', ip: `ip-${number}`, subject: `name-${number}`, response: reply,
  }, work)
  const active = [0, 1].map(number => schedule(number, response(), () => release.promise))
  const replies = Array.from({ length: 8 }, response)
  const waiters = replies.map((reply, index) => schedule(index + 2, reply, () => assert.fail('A canceled task ran')))
  const rejected = waiters.slice(1).map(waiter => assert.rejects(waiter, { status: 503 }))
  await assert.rejects(schedule(10, response(), () => assert.fail('The queue exceeded its cap')), { status: 503 })

  replies[0].close()
  assert.equal(await waiters[0], undefined)
  await Promise.all(rejected)
  for (const reply of replies) assert.equal(reply.listenerCount('close'), 0)
  assert.equal(replies[1].headers.get('Retry-After'), '1')

  const replacement = schedule(2, response(), () => 'admitted')
  release.resolve()
  await Promise.all(active)
  assert.equal(await replacement, 'admitted')
})
