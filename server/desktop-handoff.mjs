import { createHash } from 'node:crypto'
import { readJson, RequestError } from './http.mjs'

const receiptLifetime = 90_000
const idPattern = /^[a-f0-9]{32}$/u

export function createDesktopHandoff({ now = () => performance.now(), maximum = 1024 } = {}) {
  const receipts = new Map()
  let expiryTimer

  function expire(time) {
    for (const [hash, deadline] of receipts) {
      if (deadline > time) break
      receipts.delete(hash)
    }
  }

  function scheduleExpiry(time) {
    if (expiryTimer || !receipts.size) return
    const deadline = receipts.values().next().value
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined
      const time = now()
      expire(time)
      scheduleExpiry(time)
    }, Math.max(1, Math.ceil(deadline - time)))
    expiryTimer.unref()
  }

  async function handle(request, response) {
    if (request.method !== 'POST') return response.writeHead(405, { Allow: 'POST' }).end()
    if (request.url !== '/api/desktop/handoff') return response.writeHead(400).end()
    const body = await readJson(request, 80)
    const { id, action } = body
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'id') || !Object.hasOwn(body, 'action') ||
        typeof id !== 'string' || id.length !== 32 || !idPattern.test(id) || !['opened', 'status'].includes(action)) {
      throw new RequestError(400, 'Ungültige JSON-Anfrage.')
    }

    const time = now()
    expire(time)
    const hash = createHash('sha256').update(id, 'hex').digest('hex')
    if (receipts.has(hash)) return response.writeHead(204).end()
    if (action === 'status') return response.writeHead(202).end()
    if (receipts.size >= maximum) return response.writeHead(429).end()
    receipts.set(hash, time + receiptLifetime)
    scheduleExpiry(time)
    response.writeHead(204).end()
  }

  function close() {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    receipts.clear()
  }

  return { handle, close }
}
