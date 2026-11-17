import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAuth } from '../auth.mjs'
import { createCommunity } from '../community.mjs'
import { json, RequestError } from '../http.mjs'
import { preferredLanguage, responseLocale, setResponseLocale, translateError } from '../locale.mjs'
import { createQuickRooms } from '../quick-rooms.mjs'

test('response languages retain German and English and negotiate Chinese with quality weights', () => {
  const choices = [
    [undefined, 'en'], ['', 'en'], ['fr-FR, *;q=0.5', 'en'], ['de-AT,de;q=0.9,en;q=0.8', 'de'],
    ['en-GB,en;q=0.8,de;q=0.6', 'en'], ['zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN'], ['ZH-hans-SG', 'zh-CN'],
    ['de;q=0.2, zh-CN;q=0.8, en;q=0.5', 'zh-CN'], ['zh-CN;q=0,de;q=0.6', 'de'],
    ['en;q=0,zh;q=0.5', 'zh-CN'], ['zh;q=invalid,de;q=0.5', 'de'], ['zh;q=1.1,en;q=0.2', 'en'],
    ['de;q=0,zh;q=0', 'en'], ['zh;q=0.5,de;q=0.5', 'zh-CN'],
  ]
  for (const [header, expected] of choices) {
    assert.equal(preferredLanguage(header), expected, String(header))
    const response = {}
    setResponseLocale({ headers: { 'accept-language': header } }, response)
    assert.equal(responseLocale(response), expected)
  }
})

test('Chinese JSON errors preserve status and machine-readable fields and translate variable limits', () => {
  const output = {}
  const response = {
    writeHead(status, headers) { Object.assign(output, { status, headers }) },
    end(bytes) { output.body = JSON.parse(bytes) },
  }
  setResponseLocale({ headers: { 'accept-language': 'zh-CN' } }, response)
  json(response, 403, { error: 'Gib einen aktuellen Code aus deiner Authenticator-App ein.', code: 'ROOMS_OWNER_CODE' })
  assert.deepEqual(output, {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Language': 'zh-CN', Vary: 'Accept-Language' },
    body: { error: '请输入身份验证器应用中的当前验证码。', code: 'ROOMS_OWNER_CODE' },
  })
  assert.equal(translateError('Eine Einladung kann zwischen 1 und 168 Stunden gültig sein.', 'zh-CN'), '邀请的有效期可设为 1 至 168 小时。')
  assert.equal(translateError('Gib einen Namen mit höchstens 72 Zeichen ein.', 'zh-CN'), '请输入不超过 72 个字符的名称。')
  assert.equal(translateError('Bitte melde dich an.', 'en'), 'Please sign in.')
  assert.equal(translateError('Bitte melde dich an.', 'de'), 'Bitte melde dich an.')
  assert.equal(translateError('Bitte melde dich an.', 'unsupported'), 'Please sign in.')
})

test('Chinese requests create localized room defaults without changing supplied names', async t => {
  const origin = 'https://rooms.example.test'
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const auth = createAuth(db, { publicOrigin: origin })
  db.exec('CREATE TABLE topic_designers (topic_id TEXT, user_id TEXT); CREATE TABLE broadcasts(id TEXT, channel_id TEXT, ended_at INTEGER) STRICT')
  const community = createCommunity(db, { requireSession: auth.requireSession,
    appearance: { topic: () => ({}), profile: () => ({}), designPermission: () => false } })
  const media = { hasGuestSource: () => false }
  const quick = createQuickRooms(db, { publicOrigin: origin, auth, community, streams: media, watchParties: media })
  t.after(() => { quick.close(); community.close(); db.close() })

  const actor = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)')
    .run(actor, 'locale-member', '本地测试用户', '', 0, '{}', '{}', new Date().toISOString())
  db.prepare('INSERT INTO sessions VALUES (?,?,?)')
    .run(createHash('sha256').update(secret).digest(), actor, Math.floor(Date.now() / 1000) + 600)

  async function request(method, path, body, language = 'zh-CN') {
    const input = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url: path, headers: { cookie: '__Host-zelotez_session=' + secret,
        'accept-language': language, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
    })
    const chunks = []
    const output = new Writable({ write(bytes, _encoding, done) { chunks.push(bytes); done() } })
    output.writeHead = function (status, headers) { this.statusCode = status; this.headers = headers; return this }
    setResponseLocale(input, output)
    try {
      const handled = path.startsWith('/api/quick-rooms') ? await quick.handle(input, output, path)
        : await community.handle(input, output, new URL(path, origin))
      assert.equal(handled, true)
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      json(output, error.status, { error: error.message })
    }
    return { status: output.statusCode, headers: output.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined }
  }

  for (const [language, general, live] of [['zh-CN', '常规', '直播'], ['en', 'General', 'Live'], ['de', 'Allgemein', 'Live']]) {
    const { body: { topic } } = await request('POST', '/api/topics', { title: '用户设置的房间名称', visibility: 'public' }, language)
    const { body: { channels } } = await request('GET', '/api/topics/' + topic.id, undefined, language)
    assert.equal(topic.title, '用户设置的房间名称')
    assert.deepEqual(channels.map(channel => channel.title), [general, live])
  }
  for (const [source, title] of [['screen', '临时直播'], ['youtube', '临时观影派对']]) {
    const { body: room } = await request('POST', '/api/quick-rooms', { source })
    assert.equal(room.title, title)
    const { body: { channels } } = await request('GET', '/api/topics/' + room.topicId)
    assert.equal(channels[0].title, '直播')
    assert.equal((await request('DELETE', '/api/quick-rooms/' + room.topicId)).status, 204)
  }
  const invalid = await request('POST', '/api/topics', { title: '', visibility: 'public' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.headers['Content-Language'], 'zh-CN')
  assert.equal(invalid.body.error, '请输入不超过 72 个字符的名称。')
})

test('bootstrap honors standard Chinese terminal locale while retaining its English default', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rooms-locale-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const bootstrap = fileURLToPath(new URL('../bootstrap.mjs', import.meta.url))
  function run(env, ...args) {
    return spawnSync(process.execPath, [bootstrap, ...args], {
      env: { ...process.env, APP_DATA_DIR: dataDir, PUBLIC_ORIGIN: 'https://rooms.example.test',
        LANG: 'en_US.UTF-8', LC_ALL: '', LC_MESSAGES: '', ...env }, encoding: 'utf8', timeout: 5000,
    })
  }
  const chinese = run({ LANG: 'zh_CN.UTF-8' }, '--recover-owner')
  assert.equal(chinese.status, 1)
  assert.match(chinese.stderr, /请先创建站点所有者账户。/u)
  const english = run({}, '--recover-owner')
  assert.equal(english.status, 1)
  assert.match(english.stderr, /Create the site owner account first\./u)
  const override = run({ LC_ALL: 'C', LC_MESSAGES: 'zh_CN.UTF-8' }, '--recover-owner')
  assert.match(override.stderr, /Create the site owner account first\./u)
  const usage = run({ LC_MESSAGES: 'zh_CN.UTF-8' }, '--invalid-option')
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /用法：node bootstrap\.mjs/u)
})
