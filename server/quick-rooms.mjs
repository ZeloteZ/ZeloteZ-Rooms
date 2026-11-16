import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { requestAddress } from './auth.mjs'
import { json, readJson, RequestError, transaction } from './http.mjs'
import { responseLocale } from './locale.mjs'
import { createQuickChat } from './quick-chat.mjs'

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const roomIdPattern = new RegExp(`^${uuid}$`, 'u')
const quickRoute = new RegExp(`^/api/quick-rooms(?:/(${uuid}))?$`, 'u')
const guestRoute = new RegExp(`^/api/guest/(${uuid})/(session|state|playback|viewers|chat(?:/join|/leave)?|media/(${uuid}))$`, 'u')
const passwordPattern = /^[A-Za-z0-9_-]{43}$/u
const ticketPattern = /^(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u
const sources = new Set(['screen', 'youtube', 'local'])
const maxRooms = 24
const draftLifetime = 5 * 60_000
const roomLifetime = 12 * 60 * 60_000
const bucketLifetime = 60_000
const maxClients = 4096
const invalid = () => new RequestError(400, 'Ungültige Auswahl.')
const missing = () => new RequestError(404, 'Dieser Stream-Raum ist nicht verfügbar.')
const unauthorized = () => new RequestError(401, 'Das Passwort für diesen Stream-Raum fehlt oder stimmt nicht.')
const methodInvalid = () => new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
const digest = value => createHash('sha256').update(value).digest()

function roomTitle(value, source, language) {
  if (value === undefined) return source === 'screen'
    ? language === 'de' ? 'Temporärer Stream' : 'Temporary stream'
    : language === 'de' ? 'Temporäre Watchparty' : 'Temporary watch party'
  const title = typeof value === 'string' ? value.normalize('NFC').trim() : ''
  if (!title || [...title].length > 72 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(title)) throw invalid()
  return title
}

function cookieValue(request, name) {
  let value = null
  for (const cookie of (request.headers.cookie ?? '').split(';')) {
    const separator = cookie.indexOf('=')
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue
    if (value !== null) return null
    value = cookie.slice(separator + 1).trim()
  }
  return value
}

function charge(buckets, key, limit, now) {
  let bucket = buckets.get(key)
  if (bucket?.expiresAt <= now) {
    buckets.delete(key)
    bucket = null
  }
  if (!bucket) {
    if (buckets.size >= maxClients) return false
    bucket = { used: 0, expiresAt: now + bucketLifetime }
    buckets.set(key, bucket)
  }
  if (bucket.used >= limit) return false
  bucket.used++
  return true
}

export function createQuickRooms(db, { publicOrigin, trustProxyIp, auth, community, streams, watchParties, now = Date.now }) {
  const secure = new URL(publicOrigin).protocol === 'https:'
  const cookieName = secure ? '__Secure-zelotez_guest' : 'zelotez_guest'
  const signingKey = randomBytes(32)
  const redeemAttempts = new Map()
  const createAttempts = new Map()
  const chat = createQuickChat({ isGuestActive, now })
  const roomSelect = `SELECT q.*, t.title FROM quick_rooms q JOIN topics t ON t.id = q.topic_id`
  const byId = db.prepare(`${roomSelect} WHERE q.topic_id = ?`)
  const byOwner = db.prepare(`${roomSelect} WHERE q.owner_id = ?`)
  const byChannel = db.prepare(`${roomSelect} WHERE q.channel_id = ?`)
  const all = db.prepare(`${roomSelect} ORDER BY q.created_at DESC`)
  const shared = db.prepare(`${roomSelect} WHERE q.member_visibility = 1 ORDER BY q.created_at DESC`)
  const activate = db.prepare('UPDATE quick_rooms SET used = 1 WHERE channel_id = ? AND owner_id = ? AND used = 0')
  const update = db.prepare('UPDATE quick_rooms SET guest_hash = ?, member_visibility = ? WHERE topic_id = ?')
  const insertTopic = db.prepare("INSERT INTO topics(id,owner_id,title,visibility,created_at) VALUES (?,?,?,'private',?)")
  const insertOwner = db.prepare("INSERT INTO topic_members(topic_id,user_id,role,approved,joined_at) VALUES (?,?,'owner',1,?)")
  const insertChannel = db.prepare("INSERT INTO channels(id,topic_id,title,type,stream_policy) VALUES (?,?,?,'live','admins')")
  const insert = db.prepare(`INSERT INTO quick_rooms(topic_id,channel_id,owner_id,owner_session,source,
    member_visibility,guest_hash,created_at,draft_until,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)

  function isActive(room, time = now()) {
    if (!room || room.expires_at <= time || !auth.isSessionActive(room.owner_session, room.owner_id)) return false
    if (!room.used) return room.draft_until > time
    const media = room.source === 'screen' ? streams : watchParties
    return media.hasGuestSource(room.channel_id, room.owner_id)
  }

  function sweep() {
    const time = now()
    for (const buckets of [redeemAttempts, createAttempts]) {
      for (const [id, entry] of buckets) if (entry.expiresAt <= time) buckets.delete(id)
    }
    for (const room of all.all()) if (!isActive(room, time)) removeRoom(room)
    chat.sweep()
  }

  function removeRoom(room) {
    community.removeTemporaryTopic(room.topic_id, room.owner_id)
    chat.removeRoom(room.topic_id)
  }

  function activeRoom(id) {
    const room = typeof id === 'string' && roomIdPattern.test(id) ? byId.get(id) : null
    if (!isActive(room)) throw missing()
    return room
  }

  function ownedRoom(actor, id) {
    const room = activeRoom(id)
    if (room.owner_id !== actor.id) throw missing()
    return room
  }

  function details(room, secret) {
    return { topicId: room.topic_id, channelId: room.channel_id, publicId: room.topic_id,
      guestPath: '/guest/' + room.topic_id, title: room.title, source: room.source,
      guestAccess: Boolean(room.guest_hash), memberVisibility: room.member_visibility === 1, expiresAt: room.expires_at,
      ...(secret && { secret }) }
  }

  function create(request, response, actor, input) {
    const { source, guestAccess = false, memberVisibility = false } = input
    if (!sources.has(source) || typeof guestAccess !== 'boolean' || typeof memberVisibility !== 'boolean') throw invalid()
    const title = roomTitle(input.title, source, responseLocale(response))
    sweep()
    const time = now()
    if (!charge(createAttempts, actor.id, 6, time)) throw new RequestError(429, 'Warte einen Moment, bevor du es erneut versuchst.')
    if (byOwner.get(actor.id)) throw new RequestError(409, 'Du hast bereits einen temporären Stream-Raum.')
    if (all.all().length >= maxRooms) throw new RequestError(503, 'Alle temporären Stream-Räume sind belegt.')
    const session = auth.sessionKey(request)
    if (!auth.isSessionActive(session, actor.id)) throw missing()
    const topicId = randomUUID()
    const channelId = randomUUID()
    const createdAt = new Date(time).toISOString()
    const secret = guestAccess ? randomBytes(32).toString('base64url') : undefined
    transaction(db, () => {
      insertTopic.run(topicId, actor.id, title, createdAt)
      insertOwner.run(topicId, actor.id, createdAt)
      insertChannel.run(channelId, topicId, 'Live')
      insert.run(topicId, channelId, actor.id, session, source, Number(memberVisibility), secret ? digest(secret) : null,
        time, time + draftLifetime, time + roomLifetime)
    })
    return json(response, 201, details(byId.get(topicId), secret))
  }

  function change(response, room, input) {
    const { guestAccess, memberVisibility, renewPassword } = input
    if ([guestAccess, memberVisibility, renewPassword].some(value => value !== undefined && typeof value !== 'boolean')) throw invalid()
    const enabled = guestAccess ?? Boolean(room.guest_hash)
    if (renewPassword && !enabled) throw invalid()
    const secret = enabled && (renewPassword || !room.guest_hash) ? randomBytes(32).toString('base64url') : undefined
    const hash = !enabled ? null : secret ? digest(secret) : room.guest_hash
    update.run(hash, memberVisibility === undefined ? room.member_visibility : Number(memberVisibility), room.topic_id)
    return json(response, 200, details(byId.get(room.topic_id), secret))
  }

  function assertTemporarySource(channelId, userId, source) {
    const room = byChannel.get(channelId)
    if (!room) return
    if (room.owner_id !== userId || !isActive(room)) throw missing()
    if (room.used || room.source !== source) throw new RequestError(409, 'Dieser temporäre Raum gehört bereits zu einer Freigabe.')
  }

  function noteTemporarySource(channelId, userId) {
    activate.run(channelId, userId)
  }

  function ticketDigest(room, unsigned) {
    return createHmac('sha256', signingKey).update(room.topic_id).update(room.guest_hash).update(unsigned).digest()
  }

  function ticketValid(room, ticket, time = now()) {
    const parts = typeof ticket === 'string' && ticketPattern.exec(ticket)
    if (!room.guest_hash || !parts || Number(parts[1]) * 1000 <= time || Number(parts[1]) * 1000 > room.expires_at) return false
    const provided = Buffer.from(parts[3], 'base64url')
    return provided.toString('base64url') === parts[3] && timingSafeEqual(provided, ticketDigest(room, `${parts[1]}.${parts[2]}`))
  }

  function exchange(request, response, room, password) {
    if (!room.guest_hash) throw missing()
    const time = now()
    if (!charge(redeemAttempts, requestAddress(request, trustProxyIp), 20, time)) {
      throw new RequestError(429, 'Warte einen Moment, bevor du es erneut versuchst.')
    }
    if (typeof password !== 'string' || !passwordPattern.test(password) || !timingSafeEqual(digest(password), room.guest_hash)) throw unauthorized()
    const expires = Math.floor(room.expires_at / 1000)
    const unsigned = `${expires}.${randomBytes(16).toString('base64url')}`
    const ticket = unsigned + '.' + ticketDigest(room, unsigned).toString('base64url')
    response.writeHead(204, { 'Set-Cookie': `${cookieName}=${ticket}; Path=/api/guest/${room.topic_id}/; HttpOnly; SameSite=Strict` +
      `; Max-Age=${Math.max(0, expires - Math.floor(time / 1000))}${secure ? '; Secure' : ''}` }).end()
  }

  function accountAccess(room, userId, session) {
    return (room.member_visibility === 1 || room.owner_id === userId) && auth.isSessionActive(session, userId)
  }

  function scope(room, guestKey) {
    return { roomId: room.topic_id, channelId: room.channel_id, ownerId: room.owner_id, source: room.source, guestKey }
  }

  function guestAccess(request, id) {
    const room = activeRoom(id)
    const ticket = cookieValue(request, cookieName)
    if (ticketValid(room, ticket)) return scope(room, { token: ticket })
    const user = auth.session(request)
    const session = user ? auth.sessionKey(request) : null
    if (user && accountAccess(room, user.id, session)) {
      return { ...scope(room, { userId: user.id, session }), displayName: user.displayName }
    }
    if (!room.guest_hash) throw missing()
    throw unauthorized()
  }

  function isGuestActive(key, id) {
    const room = byId.get(id)
    if (!isActive(room)) return false
    if (key?.token) return ticketValid(room, key.token)
    return Boolean(key?.userId && accountAccess(room, key.userId, key.session))
  }

  async function stateFor(room, mediaScope) {
    const stream = room.source === 'screen' && room.used ? await streams.guestSnapshot(mediaScope).catch(error => {
      if (error instanceof RequestError && error.status === 503) return null
      throw error
    }) : null
    const watch = !room.used || room.source === 'screen' ? null : watchParties.guestSnapshot(mediaScope)
    return { title: watch?.party?.title || room.title, roomTitle: room.title, source: room.source, stream,
      party: watch?.party ?? null, serverTime: watch?.serverTime ?? now() }
  }

  async function homeActivity() {
    const entries = await Promise.all(shared.all().map(async room => {
      if (!room.used || !isActive(room)) return null
      const state = await stateFor(room, scope(room))
      if (!state.stream && !state.party) return null
      const current = byId.get(room.topic_id)
      if (current?.member_visibility !== 1 || !isActive(current)) return null
      return { publicId: room.topic_id, title: state.title, source: room.source }
    }))
    return entries.filter(Boolean)
  }

  async function handleGuest(request, response, path) {
    const route = guestRoute.exec(path)
    if (!route) return false
    const [, id, action, partyId] = route
    if (action === 'session') {
      if (request.method !== 'POST') throw methodInvalid()
      const { password } = await readJson(request, 256)
      exchange(request, response, activeRoom(id), password)
    } else {
      const mediaScope = guestAccess(request, id)
      const isActive = () => isGuestActive(mediaScope.guestKey, id)
      if (action.startsWith('chat')) {
        await chat.handle(request, response, mediaScope, action.split('/')[1] ?? 'chat', new URL(request.url, publicOrigin))
      } else if (action === 'viewers') {
        if (!['POST', 'DELETE'].includes(request.method)) throw methodInvalid()
        if (mediaScope.source !== 'youtube') throw missing()
        const input = await readJson(request, 512)
        if (!isActive()) throw unauthorized()
        watchParties.reportGuestViewer(mediaScope, input, request.method, isActive)
        response.writeHead(204).end()
      } else if (partyId) {
        if (!['GET', 'HEAD'].includes(request.method)) throw methodInvalid()
        await watchParties.serveGuestMedia(request, response, mediaScope, partyId, isActive)
      } else {
        if (action === 'playback') {
          if (request.method !== 'PATCH') throw methodInvalid()
          if (mediaScope.source === 'screen') throw missing()
          const input = await readJson(request, 256)
          if (!isActive()) throw unauthorized()
          watchParties.controlGuestPlayback(mediaScope, input)
        } else if (request.method !== 'GET') throw methodInvalid()
        const state = await stateFor(byId.get(id), mediaScope)
        if (!isActive()) throw unauthorized()
        json(response, 200, state)
      }
    }
    return true
  }

  async function handle(request, response, path) {
    if (path === '/api/quick-rooms/destinations') {
      const actor = auth.requireSession(request)
      if (request.method !== 'GET') throw methodInvalid()
      json(response, 200, { channels: community.quickDestinations(actor.id) })
      return true
    }
    const route = quickRoute.exec(path)
    if (!route) return false
    const [, id] = route
    const method = request.method
    const actor = auth.requireSession(request)
    const input = method === 'POST' || method === 'PATCH' ? await readJson(request, 1024) : null
    const user = auth.requireSession(request)
    if (user.id !== actor.id) throw missing()
    if (!id && method === 'POST') create(request, response, user, input)
    else if (!id && method === 'GET') {
      const room = byOwner.get(user.id)
      json(response, 200, { room: isActive(room) ? details(room) : null })
    } else if (id && method === 'GET') json(response, 200, details(ownedRoom(user, id)))
    else if (id && method === 'PATCH') change(response, ownedRoom(user, id), input)
    else if (id && method === 'DELETE') {
      removeRoom(ownedRoom(user, id))
      response.writeHead(204).end()
    } else throw methodInvalid()
    return true
  }

  function checkGuestViewer(request, response) {
    let mediaScope
    try { mediaScope = guestAccess(request, request.headers['x-guest-room']) } catch (error) {
      if (!(error instanceof RequestError)) throw error
      return response.writeHead(error.status === 401 ? 401 : 403).end()
    }
    return streams.checkGuestViewer(request, response, mediaScope)
  }

  const cleanup = setInterval(() => {
    try { sweep() } catch (error) { console.error('Temporary room cleanup failed', error.code ?? error.name) }
  }, 4000)
  cleanup.unref()

  function close() {
    clearInterval(cleanup)
    chat.close()
  }

  return { handle, handleGuest, checkGuestViewer, homeActivity, assertTemporarySource, noteTemporarySource,
    isTemporaryTopic: topicId => Boolean(byId.get(topicId)),
    isTemporaryChannel: channelId => Boolean(byChannel.get(channelId)), close }
}
