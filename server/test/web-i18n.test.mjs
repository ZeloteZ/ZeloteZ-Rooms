import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { language, languages, locale, setLanguage, t as translate } from '../../web/i18n.js'
import chinese from '../../web/i18n-zh.js'

const preference = 'zelotez-rooms-language'

function browser(t, address, saved, blocked = false) {
  const previous = new Map(['location', 'localStorage', 'history'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const values = new Map(saved ? [[preference, saved]] : [])
  const location = new URL(address)
  const storage = {
    getItem: key => {
      if (blocked) throw new Error('Storage blocked')
      return values.get(key) ?? null
    },
    setItem: (key, value) => {
      if (blocked) throw new Error('Storage blocked')
      values.set(key, value)
    },
  }
  Object.defineProperties(globalThis, {
    location: { value: location, configurable: true },
    localStorage: { value: storage, configurable: true },
    history: { value: { state: { preserved: true }, replaceState(state, title, address) { location.href = address } }, configurable: true },
  })
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { location, values }
}

test('Chinese language links and saved preferences use the canonical chooser value', t => {
  const env = browser(t, 'https://rooms.example.test/?lang=zh-hans-CN#/rooms/example', 'de')
  assert.equal(language(), 'zh-CN')
  assert.equal(locale(), 'zh-CN')
  assert.ok(languages.some(entry => entry.id === language() && entry.label === '简体中文'))
  assert.equal(translate('Queue', 'Warteschlange'), '播放队列')
  assert.equal(translate('Return to “{title}”', 'Zurück zu „{title}“', { title: '我的电影' }), '返回“我的电影”')
  setLanguage('zh')
  assert.equal(env.values.get(preference), 'zh-CN')
  assert.equal(env.location.searchParams.get('lang'), 'zh-CN')
  assert.equal(env.location.hash, '#/rooms/example')
  setLanguage('de')
  assert.equal(translate('Queue', 'Warteschlange'), 'Warteschlange')
  setLanguage('en')
  assert.equal(translate('Queue', 'Warteschlange'), 'Queue')
})

test('saved Chinese aliases and blocked storage preserve language choice and room links', t => {
  const env = browser(t, 'https://rooms.example.test/#/rooms/example', 'zh_CN')
  assert.equal(language(), 'zh-CN')
  setLanguage('unsupported')
  assert.equal(env.values.get(preference), 'zh_CN')
  assert.equal(env.location.search, '')
  setLanguage('de')
  assert.equal(language(), 'de')
  assert.equal(env.location.search, '')
})

test('the language picker falls back to the URL when local storage is unavailable', t => {
  const env = browser(t, 'https://rooms.example.test/#/rooms/example?watch=fixture', undefined, true)
  assert.equal(language(), 'en')
  setLanguage('zh-CN')
  assert.equal(language(), 'zh-CN')
  assert.equal(env.location.searchParams.get('lang'), 'zh-CN')
  assert.equal(env.location.hash, '#/rooms/example?watch=fixture')
  assert.equal(translate('Unregistered message', 'Nicht registriert'), 'Unregistered message')
})

const literal = String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`
const placeholders = text => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map(match => match[1]).sort()

test('the Chinese catalog covers UI messages, array labels and tutorial copy with matching placeholders', async () => {
  const required = new Map()
  function add(source, file) {
    required.set(runInNewContext(source), file)
  }
  const root = new URL('../../web/', import.meta.url)
  for (const file of await readdir(root)) {
    if (!file.endsWith('.js') || file.startsWith('i18n')) continue
    const source = await readFile(new URL(file, root), 'utf8')
    for (const match of source.matchAll(new RegExp(String.raw`\b(?:t|errorText)\(\s*${literal}`, 'g'))) add(match[1], file)
    if (file === 'tutorial.js') {
      const pattern = String.raw`\bstep\(\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*,\s*${literal}`
      for (const match of source.matchAll(new RegExp(pattern, 'g'))) {
        add(match[2], file)
        add(match[4], file)
      }
    }
    if (['guest-viewer.js', 'quick-chat.js', 'reactions.js', 'people.js'].includes(file)) {
      for (const match of source.matchAll(new RegExp(String.raw`\[\s*${literal}\s*,\s*${literal}\s*\]`, 'g'))) {
        if (/^[A-Z{]/u.test(runInNewContext(match[1]))) add(match[1], file)
      }
    }
    if (file === 'quick-start.js') {
      const pattern = String.raw`\[\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*\]`
      for (const match of source.matchAll(new RegExp(pattern, 'g'))) {
        add(match[2], file)
        add(match[4], file)
      }
    }
    if (file === 'appearance.js') {
      for (const match of source.matchAll(new RegExp(String.raw`\ben:\s*${literal}\s*,\s*de:`, 'g'))) add(match[1], file)
      const pattern = String.raw`\[\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*,\s*${literal}\s*\]`
      for (const match of source.matchAll(new RegExp(pattern, 'g'))) add(match[3], file)
    }
  }
  for (const [key, file] of required) {
    assert.ok(Object.hasOwn(chinese, key), file + ' is missing a Chinese translation for ' + key)
  }
  for (const [key, value] of Object.entries(chinese)) {
    assert.equal(typeof value, 'string', key)
    assert.ok(value.length > 0, key)
    assert.deepEqual(placeholders(value), placeholders(key), key)
  }
})

test('classic crypto errors follow the selected Chinese document language', async () => {
  const script = await readFile(new URL('../../web/crypto.js', import.meta.url), 'utf8')
  const window = {}
  const document = { documentElement: { lang: 'zh-CN' } }
  runInNewContext(script, { window, document, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget })
  await assert.rejects(window.ClubCrypto.openMessage('channel', 'message', {}), { message: '请重新解锁会话。' })
  document.documentElement.lang = 'de'
  await assert.rejects(window.ClubCrypto.openMessage('channel', 'message', {}), { message: 'Entsperre deine Sitzung erneut.' })
  document.documentElement.lang = 'en'
  await assert.rejects(window.ClubCrypto.openMessage('channel', 'message', {}), { message: 'Unlock your session again.' })
})
