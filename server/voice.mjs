import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readBytes } from './http.mjs'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const voiceRoute = new RegExp(`^/api/channels/(${uuid})/voice/(.+)$`)
const peerIdPattern = /^[a-f0-9]{32}$/
const relayResource = new RegExp(`^/voice/[a-f0-9]{32}/(?:whip|whep)/${uuid}$`)
const leasePeriod = 25_000
const joinPeriod = 12_000
const maxRoomSize = 16
const maxPeers = 64
const maxPendingPerUser = 3
const maxTransports = 256
const id = () => randomBytes(16).toString('hex')
const digest = value => createHash('sha256').update(value).digest()

// Keep a single Opus audio section. Browsers normally offer additional codecs.
function audioOffer(bytes, direction) {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/)
  const media = lines.findIndex(line => line.startsWith('m='))
  const audio = /^m=audio ([1-9][0-9]*) UDP\/TLS\/RTP\/SAVPF ([0-9]+(?: [0-9]+)*)$/.exec(lines[media])
  if (lines[0] !== 'v=0' || !audio ||
    lines.slice(media + 1).some(line => line.startsWith('m=')) ||
    !lines.slice(media + 1).includes(`a=${direction}`)) return null
  const payloads = audio[2].split(' ')
  const opus = lines.slice(media + 1).map(line => /^a=rtpmap:([0-9]+) opus\/48000\/2$/i.exec(line)?.[1])
    .find(payload => payloads.includes(payload))
  if (opus === undefined) return null
  lines[media] = `m=audio ${audio[1]} UDP/TLS/RTP/SAVPF ${opus}`
  return lines.filter(line => {
    const payload = /^a=(?:rtpmap|fmtp|rtcp-fb):([0-9]+)\s/.exec(line)?.[1]
    return payload === undefined || payload === opus
  }).join('\r\n') + '\r\n'
}

export function createVoice(db, config, {
  requireSession, sessionKey, isSessionActive, channelAccess, profileFor, readJson, json, RequestError,
}) {
  const upstream = new URL(config.mediaUrl || 'http://mediamtx:8889')
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
    upstream.href !== `${upstream.origin}/`) throw new Error('Invalid MediaMTX WebRTC URL')

  const basicSecret = randomBytes(32).toString('base64url')
  const secretHash = digest(basicSecret)
  const peers = new Map()
  const transports = new Map()
  const grants = new Map()
  const negotiating = new Set()
  let closed = false

  // Persist only private relay handles, so a Node restart can revoke old transports.
  db.exec('CREATE TABLE IF NOT EXISTS voice_relay_sessions (resource TEXT PRIMARY KEY) STRICT')
  const saveResource = db.prepare('INSERT INTO voice_relay_sessions(resource) VALUES (?)')
  const forgetResource = db.prepare('DELETE FROM voice_relay_sessions WHERE resource = ?')
  const staleResources = new Set(db.prepare('SELECT resource FROM voice_relay_sessions').all().map(row => row.resource))
  const deleting = new Set()
  const names = db.prepare('SELECT display_name FROM users WHERE id = ?')
  const roomInfo = db.prepare(`SELECT c.id AS channelId, c.title AS channelTitle, t.id AS topicId, t.title AS topicTitle
    FROM channels c JOIN topics t ON t.id = c.topic_id WHERE c.id = ? AND c.type = 'live'`)

  const cannotEnter = () => new RequestError(404, 'Talk-Raum nicht gefunden.')
  const expired = () => new RequestError(410, 'Deine Teilnahme am Talk ist abgelaufen.')
  const canView = (userId, channelId) => channelAccess(userId, channelId)?.canView === true
  const validPeer = peer => peer && peer.until > Date.now() && peers.get(peer.id) === peer &&
    isSessionActive(peer.session, peer.userId) && canView(peer.userId, peer.channelId)
  const stillHere = peer => peer?.confirmed && validPeer(peer)

  async function flushDeletes() {
    const resources = [...staleResources].filter(resource => !deleting.has(resource)).slice(0, 20)
    await Promise.all(resources.map(async resource => {
      deleting.add(resource)
      try {
        if (relayResource.test(resource)) {
          const result = await fetch(new URL(resource, upstream), { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3500) })
          await result.body?.cancel()
          if (!result.ok && result.status !== 404) return
        }
        if (!closed) forgetResource.run(resource)
        staleResources.delete(resource)
      } catch {
        // Retry against MediaMTX on the next sweep.
      } finally {
        deleting.delete(resource)
      }
    }))
  }

  function removeTransport(transport) {
    transports.delete(transport.id)
    const peer = peers.get(transport.peerId)
    if (peer?.publishId === transport.id) peer.publishId = null
    staleResources.add(transport.resource)
    if (transport.kind === 'publish') {
      for (const listening of transports.values()) {
        if (listening.targetId === transport.id) removeTransport(listening)
      }
    }
  }

  function removePeer(peer) {
    for (const transport of transports.values()) if (transport.peerId === peer.id) removeTransport(transport)
    peers.delete(peer.id)
  }

  function sweep() {
    for (const peer of peers.values()) if (!validPeer(peer)) removePeer(peer)
    if (staleResources.size) void flushDeletes()
  }

  const timer = setInterval(sweep, 3000)
  timer.unref()
  if (staleResources.size) void flushDeletes()

  function member(peer) {
    return {
      id: peer.id, userId: peer.userId, displayName: names.get(peer.userId)?.display_name ?? peer.displayName,
      ...profileFor(peer.userId), publishing: Boolean(peer.publishId), mediaVersion: peer.publishId,
    }
  }

  function roster(peer) {
    return {
      self: member(peer), members: [...peers.values()].filter(other => other.channelId === peer.channelId && stillHere(other)).map(member),
      iceServers: [],
    }
  }

  function homeActivity(userId) {
    const rooms = new Map()
    const evaluated = new Set()
    for (const peer of peers.values()) {
      if (!stillHere(peer)) continue
      if (!evaluated.has(peer.channelId)) {
        evaluated.add(peer.channelId)
        if (canView(userId, peer.channelId)) {
          const room = roomInfo.get(peer.channelId)
          if (room) rooms.set(peer.channelId, { ...room, members: [] })
        }
      }
      rooms.get(peer.channelId)?.members.push(member(peer))
    }
    return [...rooms.values()]
  }

  function ownPeer(peerId, actor, channelId, session, { allowPending = false, optional = false } = {}) {
    if (typeof peerId !== 'string' || !peerIdPattern.test(peerId)) throw cannotEnter()
    const peer = peers.get(peerId)
    if (!peer && optional) return null
    if (!peer) throw expired()
    if (peer.userId !== actor.id || peer.channelId !== channelId || peer.session !== session) throw cannotEnter()
    if (!validPeer(peer) || (!optional && !allowPending && !peer.confirmed)) throw expired()
    return peer
  }

  function activePeer(userId) {
    return [...peers.values()].find(peer => peer.userId === userId && stillHere(peer))
  }

  function talkConflict(response, peer) {
    json(response, 409, {
      error: 'Du bist bereits in einem Sprachchat verbunden.', activePeerId: peer.id,
    })
  }

  function reserve(response, actor, channelId, session, { attemptId = id(), replacePeerId = null }) {
    if (typeof attemptId !== 'string' || !peerIdPattern.test(attemptId) ||
      (replacePeerId !== null && (typeof replacePeerId !== 'string' || !peerIdPattern.test(replacePeerId)))) {
      throw new RequestError(400, 'Ungültige Talk-Verbindung.')
    }
    const existing = [...peers.values()].find(peer => peer.attemptId === attemptId && peer.userId === actor.id &&
      peer.session === session && peer.channelId === channelId && validPeer(peer))
    if (existing) return json(response, 200, roster(existing))

    const active = activePeer(actor.id)
    if (active && active.id !== replacePeerId) return talkConflict(response, active)
    const ownPending = [...peers.values()].filter(peer => peer.userId === actor.id && !peer.confirmed).length
    if (peers.size >= maxPeers * 2 || ownPending >= maxPendingPerUser) {
      throw new RequestError(429, 'Warte einen Moment, bevor du den Sprachchat erneut betrittst.')
    }
    const peer = {
      id: id(), attemptId, replacePeerId, session, channelId, userId: actor.id, displayName: actor.displayName,
      until: Date.now() + joinPeriod, confirmed: false, publishId: null,
    }
    peers.set(peer.id, peer)
    json(response, 200, roster(peer))
  }

  function heartbeat(response, peer) {
    if (!peer.confirmed) {
      const active = activePeer(peer.userId)
      if (active && active.id !== peer.replacePeerId) {
        removePeer(peer)
        return talkConflict(response, active)
      }
      const otherPeers = [...peers.values()].filter(other => other !== active && stillHere(other))
      if (otherPeers.length >= maxPeers || otherPeers.filter(other => other.channelId === peer.channelId).length >= maxRoomSize) {
        throw new RequestError(409, 'Der Sprachchat ist voll. Versuch es später erneut.')
      }
      if (active) removePeer(active)
      peer.confirmed = true
      if (staleResources.size) void flushDeletes()
    }
    peer.until = Date.now() + leasePeriod
    json(response, 200, roster(peer))
  }

  function incomingSpeaker(peer, speakerId) {
    const speaker = peers.get(speakerId)
    if (speaker === peer || speaker?.channelId !== peer.channelId || !stillHere(speaker) || !speaker.publishId) return null
    return transports.get(speaker.publishId)
  }

  async function negotiate(request, response, actor, peer, kind, speakerId) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/sdp') {
      throw new RequestError(415, 'Eine SDP-Verbindungsanfrage wird erwartet.')
    }
    const lock = `${peer.id}/${speakerId ?? 'self'}`
    if (negotiating.has(lock) || negotiating.size >= 32 || transports.size + negotiating.size >= maxTransports || staleResources.size >= maxTransports) {
      throw new RequestError(429, 'Zu viele Sprachverbindungen gleichzeitig. Versuch es gleich erneut.')
    }
    negotiating.add(lock)
    const key = `voice-${id()}`
    let resource
    let retained = false
    try {
      const bytes = await readBytes(request, 48 * 1024)
      let offer
      try { offer = audioOffer(bytes, kind === 'publish' ? 'sendonly' : 'recvonly') } catch { /* malformed SDP */ }
      if (!offer) throw new RequestError(400, 'Der Talk unterstützt eine einzelne Opus-Tonspur.')
      if (requireSession(request).id !== actor.id || !stillHere(peer)) throw expired()

      const current = kind === 'listen' ? incomingSpeaker(peer, speakerId) : null
      if (kind === 'listen' && !current) throw new RequestError(409, 'Diese Person sendet gerade keinen Ton.')
      const transportId = id()
      const publish = kind === 'publish'
      const path = `voice/${publish ? transportId : current.id}`
      const endpoint = `/${path}/${publish ? 'whip' : 'whep'}`
      grants.set(key, { peer, path, action: publish ? 'publish' : 'read', speakerId, targetId: current?.id })
      let result
      try {
        result = await fetch(new URL(endpoint, upstream), {
          method: 'POST', body: offer, redirect: 'error', signal: AbortSignal.timeout(9000),
          headers: { 'Content-Type': 'application/sdp', Authorization: `Basic ${Buffer.from(`${key}:${basicSecret}`).toString('base64')}` },
        })
      } catch {
        throw new RequestError(502, 'Der Sprachserver ist gerade nicht erreichbar.')
      }
      if (result.status !== 201) {
        await result.body?.cancel()
        if (kind === 'listen' && result.status === 404) throw new RequestError(409, 'Die Tonspur wird noch verbunden.')
        throw new RequestError(502, 'Der Sprachserver konnte die Verbindung nicht öffnen.')
      }
      const location = result.headers.get('Location')
      if (!location || !relayResource.test(location) || !location.startsWith(endpoint + '/')) {
        await result.body?.cancel()
        throw new RequestError(502, 'Der Sprachserver hat eine ungültige Antwort geliefert.')
      }
      resource = location
      saveResource.run(resource)
      const answer = await result.text()
      if (requireSession(request).id !== actor.id || !stillHere(peer) || response.destroyed ||
        (!publish && incomingSpeaker(peer, speakerId)?.id !== current.id)) throw expired()

      for (const old of transports.values()) {
        if (old.peerId === peer.id && old.kind === kind && old.speakerId === speakerId) removeTransport(old)
      }
      transports.set(transportId, { id: transportId, peerId: peer.id, speakerId, targetId: current?.id, kind, resource })
      if (publish) peer.publishId = transportId
      retained = true
      response.writeHead(201, {
        'Content-Type': 'application/sdp',
        Location: `/api/channels/${peer.channelId}/voice/${peer.id}/sessions/${transportId}`,
        ...(current ? { 'X-Voice-Media-Version': current.id } : {}),
      }).end(answer)
    } finally {
      grants.delete(key)
      negotiating.delete(lock)
      if (resource && !retained) staleResources.add(resource)
      if (staleResources.size) void flushDeletes()
    }
  }

  async function handle(request, response, pathname) {
    const match = voiceRoute.exec(pathname)
    if (!match) return false
    const [, channelId, operation] = match
    const actor = requireSession(request)
    const session = sessionKey(request)
    if (!canView(actor.id, channelId)) throw cannotEnter()
    sweep()
    if (request.method === 'POST' && operation === 'join') {
      const offer = await readJson(request, 512)
      if (requireSession(request).id !== actor.id || !canView(actor.id, channelId)) throw cannotEnter()
      if (!response.destroyed) reserve(response, actor, channelId, session, offer)
      return true
    }
    if (request.method === 'POST' && operation === 'heartbeat') {
      const { peerId } = await readJson(request, 512)
      if (requireSession(request).id !== actor.id) throw expired()
      const peer = ownPeer(peerId, actor, channelId, session, { allowPending: true })
      if (!response.destroyed) heartbeat(response, peer)
      return true
    }
    const [peerId, action, targetId, extra] = operation.split('/')
    if (extra !== undefined || !peerIdPattern.test(peerId)) return false
    if (request.method === 'DELETE' && (!action || (action === 'sessions' && peerIdPattern.test(targetId)))) {
      const peer = ownPeer(peerId, actor, channelId, session, { optional: true })
      if (peer && !action) removePeer(peer)
      if (peer && action) {
        const transport = transports.get(targetId)
        if (transport?.peerId === peer.id) removeTransport(transport)
      }
      if (staleResources.size) await flushDeletes()
      response.writeHead(204).end()
      return true
    }
    if (request.method === 'POST' && ((action === 'publish' && targetId === undefined) || (action === 'listen' && peerIdPattern.test(targetId)))) {
      const peer = ownPeer(peerId, actor, channelId, session)
      await negotiate(request, response, actor, peer, action, targetId)
      return true
    }
    return false
  }

  function handleMedia(auth, response) {
    if (auth?.protocol !== 'webrtc' || typeof auth.path !== 'string' || !auth.path.startsWith('voice/')) return false
    const grant = grants.get(auth.user)
    const accepted = grant && typeof auth.password === 'string' && timingSafeEqual(digest(auth.password), secretHash) &&
      auth.action === grant.action && auth.path === grant.path && stillHere(grant.peer) &&
      (grant.action === 'publish' || incomingSpeaker(grant.peer, grant.speakerId)?.id === grant.targetId)
    response.writeHead(accepted ? 200 : 401).end()
    return true
  }

  function close() {
    clearInterval(timer)
    closed = true
    for (const peer of peers.values()) removePeer(peer)
    if (staleResources.size) void flushDeletes()
  }

  return { handle, handleMedia, homeActivity, close }
}
