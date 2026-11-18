import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../../web/crypto.js', import.meta.url), 'utf8')

// Synthetic v1 account and message produced by the pre-rotation client (8d9846f).
const previousPassword = 'The first test passphrase'
const previousCredential = '9OwWwjRG47g1Zb7xhCaBFS80x262WeBbmfFCraR56fc'
const user = {
  id: '06dd142f-39b9-4ddb-9378-86c0bab49031', username: 'longtime-member',
  publicKey: { kty: 'EC', crv: 'P-256', x: 'ipXCjEdaTXKx007vlBipco4n3AbLTyQ_XY34Un63VzA',
    y: 'sUx6yFCoSDmnCHv7XQndI5hDMn5f_-4yuFPMxoDKwWo' },
  identity: { v: 1, nonce: 'R9ahQbiiIrgXExA-',
    blob: 'tYh-Ofjb9teYluZUzT66gbtk_KIwLCdYs9Tm64jVSvlUazNYwAJoRrJsTB4O23oMPVkO86bVbkgmO4rd0J1CNbmBzuKVOYB6tmj85M_4HZDCopyL5lwRgpi1gqu0CNpnLNFCmtZiSdpUR3ZYPEgJo7pXjKCwaOfTfoxjTXGHb7cS_PhBOh5MbHfXO-bfQmY92hBV5Ab32JOnUjcUhaBd3TaL_5M_M2yitof-7vMdzLWyVETKZ8gamvYvOi1ckK5SoVdqyPyn6XbC7o2LAWLtoPa_hiVnN8QQY8HDrAUIxt1nM7Lb' },
}
const channel = 'acb32b77-4a54-4d56-88d9-e15c68003ca6'
const message = 'df902b4d-5d99-479e-ba58-847605caf60a'
const content = 'This message was sealed with the original chat identity.'
const envelope = {
  v: 1,
  ephemeral: { kty: 'EC', crv: 'P-256', x: 'gLyQE3MTFz4EFcDXcAP3eCLqZ3syoFnVpzpepmd-hII',
    y: 'xVgdQ6TpMq-EzFih7_hgW_5h6Or3dfoUWH-XZAhJvBc' },
  nonce: 'jZcHWNjvfYnA0hMm',
  body: 'u_R-wpwWqxRbsFf2kJ5ABdHgjNiIz2JQtalTgbK5WSczART343hHLOACRf_JOgyAmtr4lccMIb5V5jg6oVyH9gWlex1BxFUzEpPd3ueMsDiESjs',
  keys: { [user.id]: { nonce: 'BK7izshnLrUGLrG-', blob: '1My8iVc8HOc8DYqG1qyoS3jZJcp4j2vrkEDImV0cLB4eJpmEUvOFzPcwSVEbTZfu' } },
}

function storage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

function browserCrypto() {
  const window = {}
  const globals = { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa,
    sessionStorage: storage(), localStorage: storage(), location: { origin: 'https://rooms.example.test' } }
  runInNewContext(script, globals, { filename: 'web/crypto.js' })
  return window.ClubCrypto
}

test('changing the password rewraps an existing chat identity without losing its message keys', async () => {
  const before = browserCrypto()
  const newPassword = 'A different test passphrase'
  assert.equal(await before.credential(user.username, previousPassword), previousCredential)
  assert.equal(await before.unlock(user, previousPassword), true)
  assert.equal((await before.openMessage(channel, message, envelope)).content.text, content)
  before.lock()

  await assert.rejects(() => before.rewrapIdentity(user, 'Incorrect previous password', newPassword))
  const updated = await before.rewrapIdentity(user, previousPassword, newPassword)
  assert.notEqual(updated.password, previousCredential)
  assert.notEqual(updated.identity.blob, user.identity.blob)
  const changedUser = { ...user, identity: updated.identity }

  const after = browserCrypto()
  assert.equal(updated.password, await after.credential(user.username, newPassword))
  assert.equal(await after.unlock(changedUser, previousPassword), false)
  assert.equal(await after.unlock(changedUser, newPassword), true)
  assert.equal((await after.openMessage(channel, message, envelope)).content.text, content)
})

test('new passwords require fifteen Unicode characters and reject common local variants', async () => {
  const encryption = browserCrypto()
  for (const password of ['Maple!River8Qs', '🔒'.repeat(14)]) {
    assert.throws(() => encryption.assertNewPassword(password), /at least 15/)
    await assert.rejects(encryption.prepareRegistration('new-member', password), /at least 15/)
    await assert.rejects(encryption.rewrapIdentity(user, previousPassword, password), /at least 15/)
  }
  for (const password of ['Password123456789!', 'correct horse battery staple', 'PasswortPasswort',
    'pAsSwOrDpassword', '111111111111111', ' '.repeat(15)]) {
    assert.throws(() => encryption.assertNewPassword(password), /too common/)
    await assert.rejects(encryption.prepareRegistration('new-member', password), /too common/)
    await assert.rejects(encryption.rewrapIdentity(user, previousPassword, password), /too common/)
  }
  const exact = 'Maple!River8Qs+'
  assert.equal([...exact].length, 15)
  assert.doesNotThrow(() => encryption.assertNewPassword(exact))
  assert.doesNotThrow(() => encryption.assertNewPassword('🦉🌿🔐🪷🧭🎨🍃🚲🦋🍂🌙🪁🪺🫖🎻'))
  // Login credentials keep their existing format and accept pre-policy passwords.
  assert.match(await encryption.credential('legacy-member', 'old-password'), /^[A-Za-z0-9_-]{43}$/)
})
