import { createHash, createPublicKey } from 'node:crypto'
import { json, readJson, RequestError } from './http.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const base64url = /^[A-Za-z0-9_-]+$/u
const maxRooms = 24
const maxPeers = 96
const maxDevicesPerCredential = 4
const maxMessages = 64
const maxMessageBytes = 4112
const peerLease = 120_000
const burstWindow = 5_000

const invalid = () => new RequestError(400, 'Ungültige Auswahl.')
const unauthorized = () => new RequestError(401, 'Das Passwort für diesen Stream-Raum fehlt oder stimmt nicht.')
const conflict = () => new RequestError(409, 'Der Livechat hat sich inzwischen geändert.')
const tooBusy = () => new RequestError(429, 'Warte einen Moment, bevor du es erneut versuchst.')
const invalidMethod = () => new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
const validId = value => typeof value === 'string' && uuid.test(value)

function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function encoded(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !base64url.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === value
}

function ephemeralKey(value) {
  if (!fields(value, ['kty', 'crv', 'x', 'y']) || value.kty !== 'EC' || value.crv !== 'P-256' ||
      !encoded(value.x, 32) || !encoded(value.y, 32)) throw invalid()
  try {
    createPublicKey({ key: value, format: 'jwk' })
  } catch {
    throw invalid()
  }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }
}

function validWrap(value) {
  return fields(value, ['nonce', 'blob']) && encoded(value.nonce, 12) && encoded(value.blob, 48)
}

function senderName(scope) {
  if (scope.guestKey.token) {
    return createHash('sha256').update(scope.roomId).update(scope.guestKey.token).digest('hex').slice(0, 6).toUpperCase()
  }
  const name = typeof scope.displayName === 'string' ? scope.displayName.trim() : ''
  return [...name.replace(/[\p{Cc}\p{Cs}\p{Bidi_Control}]/gu, '')].slice(0, 48).join('') || 'Member'
}

function sameCredential(a, b) {
  return a.token ? a.token === b.token : !b.token && a.session === b.session && a.userId === b.userId
}

function consumeBurst(counter, limit, at) {
  if (counter.resetAt <= at) {
    counter.used = 0
    counter.resetAt = at + burstWindow
  }
  if (counter.used >= limit) throw tooBusy()
  counter.used++
}

export function createQuickChat({ isGuestActive, now = Date.now }) {
  const rooms = new Map()

  function assertAccess(scope) {
    if (!isGuestActive(scope.guestKey, scope.roomId)) throw unauthorized()
  }

  function pruneRevoked(id, room) {
    for (const [device, peer] of room.peers) {
      if (!isGuestActive(peer.credential, id)) room.peers.delete(device)
    }
  }

  function roomFor(scope, join = false) {
    let room = rooms.get(scope.roomId)
    if (!room && join) {
      if (rooms.size >= maxRooms) throw tooBusy()
      room = { peers: new Map(), messages: [], seq: 0, burst: { used: 0, resetAt: 0 } }
      rooms.set(scope.roomId, room)
    }
    if (!room) throw conflict()
    if (join) pruneRevoked(scope.roomId, room)
    return room
  }

  function ownPeer(room, scope, id, at) {
    const peer = room.peers.get(id)
    if (!peer || !sameCredential(peer.credential, scope.guestKey)) throw conflict()
    if (!peer.guest) peer.name = senderName(scope)
    peer.presentUntil = at + peerLease
    return peer
  }

  function snapshot(room, viewer, after, at) {
    const participants = new Map()
    const peers = [...room.peers.values()].map(({ id, credential, publicKey, name, guest, presentUntil }) => {
      const identity = guest ? `guest:${credential.token}` : `account:${credential.userId}`
      if (presentUntil > at) participants.set(identity, { name, guest })
      return { id, publicKey, name, guest }
    })
    return { deviceId: viewer.id,
      peers, participants: [...participants.values()],
      messages: room.messages.filter(message => message.seq > Math.max(after, viewer.joinedSeq) && message.keys.has(viewer.id))
        .map(({ id, from, name, guest, sentAt, publicKey, nonce, blob, keys }) => ({
          id, from, name, guest, sentAt, publicKey, envelope: { nonce, blob, key: keys.get(viewer.id) },
        })),
      cursor: room.seq,
    }
  }

  async function register(request, response, scope) {
    const input = await readJson(request, 1024)
    if (!fields(input, ['deviceId', 'publicKey']) || !validId(input.deviceId)) throw invalid()
    const publicKey = ephemeralKey(input.publicKey)
    assertAccess(scope)
    const at = now()
    const room = roomFor(scope, true)
    const existing = room.peers.get(input.deviceId)
    if (existing) {
      if (existing.publicKey.x !== publicKey.x || existing.publicKey.y !== publicKey.y) throw conflict()
      const peer = ownPeer(room, scope, input.deviceId, at)
      return json(response, 200, snapshot(room, peer, peer.joinedSeq, at))
    }
    const peers = [...room.peers.values()]
    const sameAccess = peers.filter(peer => sameCredential(peer.credential, scope.guestKey))
    const candidates = sameAccess.length >= maxDevicesPerCredential ? sameAccess : room.peers.size >= maxPeers ? peers : null
    if (candidates) {
      const dormant = candidates.filter(peer => peer.presentUntil <= at).sort((a, b) => a.presentUntil - b.presentUntil)[0]
      if (!dormant) throw tooBusy()
      room.peers.delete(dormant.id)
    }
    const peer = { id: input.deviceId, publicKey, name: senderName(scope), guest: Boolean(scope.guestKey.token),
      credential: scope.guestKey, joinedSeq: room.seq, presentUntil: at + peerLease, burst: { used: 0, resetAt: 0 } }
    room.peers.set(peer.id, peer)
    return json(response, 200, snapshot(room, peer, peer.joinedSeq, at))
  }

  function read(response, scope, url) {
    const devices = url.searchParams.getAll('deviceId')
    const cursors = url.searchParams.getAll('after')
    const cursor = cursors[0] ?? '0'
    if (devices.length !== 1 || !validId(devices[0]) || cursors.length > 1 || !/^\d{1,16}$/u.test(cursor) ||
        !Number.isSafeInteger(Number(cursor)) || url.searchParams.size !== devices.length + cursors.length) throw invalid()
    assertAccess(scope)
    const at = now()
    const room = roomFor(scope)
    const viewer = ownPeer(room, scope, devices[0], at)
    return json(response, 200, snapshot(room, viewer, Number(cursor), at))
  }

  async function post(request, response, scope) {
    const input = await readJson(request, 24576)
    if (!fields(input, ['deviceId', 'id', 'envelope']) || !validId(input.deviceId) || !validId(input.id) ||
        !fields(input.envelope, ['nonce', 'blob', 'keys'])) throw invalid()
    const { nonce, blob, keys } = input.envelope
    if (!encoded(nonce, 12) || !encoded(blob, 17, maxMessageBytes) || !keys || typeof keys !== 'object' || Array.isArray(keys) ||
        Object.keys(keys).length > maxPeers) throw invalid()
    assertAccess(scope)
    const at = now()
    const room = roomFor(scope)
    pruneRevoked(scope.roomId, room)
    const sender = ownPeer(room, scope, input.deviceId, at)
    const previous = room.messages.find(message => message.id === input.id)
    if (previous) {
      if (previous.from !== sender.id) throw conflict()
      return json(response, 201, snapshot(room, sender, previous.seq - 1, at))
    }
    if (!fields(keys, [...room.peers.keys()])) throw conflict()
    const deliveries = new Map()
    for (const [id, wrap] of Object.entries(keys)) {
      if (!validWrap(wrap)) throw invalid()
      deliveries.set(id, { nonce: wrap.nonce, blob: wrap.blob })
    }
    consumeBurst(sender.burst, 5, at)
    consumeBurst(room.burst, 20, at)
    const { name, guest, publicKey } = sender
    room.messages.push({ id: input.id, seq: ++room.seq, from: sender.id, name, guest, publicKey, sentAt: new Date(at).toISOString(),
      nonce, blob, keys: deliveries })
    if (room.messages.length > maxMessages) room.messages.shift()
    return json(response, 201, snapshot(room, sender, room.seq - 1, at))
  }

  async function leave(request, response, scope) {
    const input = await readJson(request, 256)
    if (!fields(input, ['deviceId']) || !validId(input.deviceId)) throw invalid()
    assertAccess(scope)
    const room = rooms.get(scope.roomId)
    const peer = room?.peers.get(input.deviceId)
    if (peer && sameCredential(peer.credential, scope.guestKey)) peer.presentUntil = 0
    return json(response, 200, { ok: true })
  }

  async function handle(request, response, scope, action, url) {
    if (action === 'join' && request.method === 'POST' && !url.search) return register(request, response, scope)
    if (action === 'leave' && request.method === 'POST' && !url.search) return leave(request, response, scope)
    if (action === 'chat' && request.method === 'GET') return read(response, scope, url)
    if (action === 'chat' && request.method === 'POST' && !url.search) return post(request, response, scope)
    throw invalidMethod()
  }

  function sweep() {
    for (const [id, room] of rooms) {
      pruneRevoked(id, room)
      if (!room.peers.size) rooms.delete(id)
    }
  }

  return { handle, sweep, removeRoom: id => rooms.delete(id), close: () => rooms.clear() }
}
