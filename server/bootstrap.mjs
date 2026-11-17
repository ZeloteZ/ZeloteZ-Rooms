import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapOwnerInvite, initializeAuthSchema } from './auth.mjs'
import { issueOwnerRecovery, provisionOwnerMfa } from './owner-access.mjs'

const dataDir = process.env.APP_DATA_DIR ?? '/data'
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080')
const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
if ((origin.protocol !== 'https:' && !localHttp) || origin.href !== `${origin.origin}/`) {
  throw new Error('PUBLIC_ORIGIN must be an HTTPS address or a local test address.')
}

process.umask(0o077)
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(dataDir, 'community.sqlite'), { timeout: 5000 })
try {
  initializeAuthSchema(db)
  const [option, ...extra] = process.argv.slice(2)
  if (extra.length || (option && !['--if-needed', '--setup-owner-mfa', '--recover-owner'].includes(option))) {
    throw new Error('Usage: node bootstrap.mjs [--if-needed | --setup-owner-mfa | --recover-owner]')
  }
  if (option === '--setup-owner-mfa') {
    const { key, uri } = provisionOwnerMfa(db, origin.origin)
    console.log('Add this time-based secret to your authenticator (six digits, 30 seconds). All owner sessions were revoked.')
    console.log(key)
    console.log(uri)
  } else if (option === '--recover-owner') {
    const link = issueOwnerRecovery(db, origin.origin)
    console.log('Owner sign-in is paused and existing owner sessions and unused invites were revoked.')
    console.log('Open the one-time recovery link within 20 minutes. Run the command again if it expires.')
    console.log(link)
  } else if (option !== '--if-needed' || !db.prepare('SELECT 1 FROM users WHERE admin = 1').get()) {
    const invite = bootstrapOwnerInvite(db, origin.origin)
    console.log(invite.url)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  db.close()
}
