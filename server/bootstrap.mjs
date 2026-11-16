import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapOwnerInvite, initializeAuthSchema } from './auth.mjs'

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
  const alreadyConfigured = process.argv.includes('--if-needed') && db.prepare('SELECT 1 FROM users WHERE admin = 1').get()
  if (!alreadyConfigured) {
    const invite = bootstrapOwnerInvite(db, origin.origin)
    console.log(invite.url)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  db.close()
}
