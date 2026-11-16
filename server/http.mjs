import { responseLocale, translateError } from './locale.mjs'

export class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function json(response, status, data, headers = {}) {
  if (status >= 400 && typeof data?.error === 'string') {
    const locale = responseLocale(response)
    data = { ...data, error: translateError(data.error, locale) }
    headers = { 'Content-Language': locale, Vary: 'Accept-Language', ...headers }
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(data))
}

export async function readBytes(request, maximum) {
  const oversized = () => new RequestError(413, 'Die Anfrage ist zu groß.')
  if (Number(request.headers['content-length']) > maximum) throw oversized()
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maximum) throw oversized()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export async function readJson(request, maximum = 8192) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Die Anfrage muss JSON enthalten.')
  }
  const bytes = await readBytes(request, maximum)
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error()
    return value
  } catch {
    throw new RequestError(400, 'Ungültige JSON-Anfrage.')
  }
}

export function assertOrigin(request, publicOrigin) {
  if (request.headers.origin !== publicOrigin) {
    throw new RequestError(403, 'Diese Herkunft ist für die Anfrage gesperrt.')
  }
}

export function transaction(db, change) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = change()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
