import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapOwnerInvite, initializeAuthSchema } from './auth.mjs'
import { preferredLanguage, translateError } from './locale.mjs'
import { issueOwnerRecovery, provisionOwnerMfa } from './owner-access.mjs'
import { ensureSetupKey } from './setup.mjs'

const locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0].replaceAll('_', '-')
const language = preferredLanguage(locale)
const message = text => translateError(text, language)

function terminalQr(qrcode, uri) {
  const qr = qrcode(0, 'L')
  qr.addData(uri)
  qr.make()
  const modules = qr.getModuleCount()
  const quietZone = 4
  const end = modules + quietZone
  const blocks = [' ', '▄', '▀', '█']
  const dark = (row, column) => row >= 0 && row < modules && column >= 0 && column < modules && qr.isDark(row, column)
  const lines = []
  for (let row = -quietZone; row < end; row += 2) {
    let line = ''
    for (let column = -quietZone; column < end; column++) {
      const upper = dark(row, column) ? 2 : 0
      const lower = dark(row + 1, column) ? 1 : 0
      line += blocks[upper + lower]
    }
    lines.push('\x1b[38;2;0;0;0;48;2;255;255;255m' + line + '\x1b[0m')
  }
  return lines.join('\n')
}

const dataDir = process.env.APP_DATA_DIR ?? '/data'
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080')
const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
if ((origin.protocol !== 'https:' && !localHttp) || origin.href !== `${origin.origin}/`) {
  throw new Error(message('PUBLIC_ORIGIN must be an HTTPS address or a local test address.'))
}

process.umask(0o077)
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(dataDir, 'community.sqlite'), { timeout: 5000 })
try {
  initializeAuthSchema(db)
  const [option, ...extra] = process.argv.slice(2)
  if (extra.length || (option && !['--if-needed', '--setup-owner-mfa', '--recover-owner', '--setup-key', '--ensure-setup-key'].includes(option))) {
    throw new Error('Usage: node bootstrap.mjs [--if-needed | --setup-owner-mfa | --recover-owner | --setup-key | --ensure-setup-key]')
  }
  if (option === '--setup-key' || option === '--ensure-setup-key') {
    const key = ensureSetupKey(db)
    if (option === '--setup-key') {
      if (!key) throw new Error('Die Ersteinrichtung ist nicht verfügbar. Nutze für eine bestehende Instanz die lokale Betreiber-Wiederherstellung.')
      console.log(key)
    }
  } else if (option === '--setup-owner-mfa') {
    const { default: qrcode } = await import('qrcode-generator')
    let qr
    const { key, uri } = provisionOwnerMfa(db, origin.origin, setup => {
      qr = terminalQr(qrcode, setup.uri)
    })
    console.log(message('Add this time-based secret to your authenticator (six digits, 30 seconds). All owner sessions were revoked.'))
    console.log(key)
    console.log(uri)
    console.log(message('Scan the QR code below. Enlarge the terminal or reduce its font size if needed.'))
    console.log(qr)
  } else if (option === '--recover-owner') {
    const link = issueOwnerRecovery(db, origin.origin)
    console.log(message('Owner sign-in is paused and existing owner sessions and unused invites were revoked.'))
    console.log(message('Open the one-time recovery link within 20 minutes. Run the command again if it expires.'))
    console.log(link)
  } else if (option !== '--if-needed' || !db.prepare('SELECT 1 FROM users WHERE admin = 1').get()) {
    const invite = bootstrapOwnerInvite(db, origin.origin)
    console.log(invite.url)
  }
} catch (error) {
  console.error(message(error.message))
  process.exitCode = 1
} finally {
  db.close()
}
