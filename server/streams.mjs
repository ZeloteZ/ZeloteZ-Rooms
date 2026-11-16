import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readBytes } from './http.mjs'

const streamIdPattern = /^[0-9a-f]{32}$/
const connectionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const channelStreamsPath = /^\/api\/channels\/([0-9a-f-]{36})\/streams$/
const streamPath = /^\/api\/streams\/([0-9a-f]{32})$/
const streamWhipPath = /^\/api\/streams\/([0-9a-f]{32})\/whip$/
const streamWhepPath = /^\/api\/streams\/([0-9a-f]{32})\/whep(?:\/([0-9a-f]{32}))?$/
const streamViewersPath = /^\/api\/streams\/([0-9a-f]{32})\/viewers$/
const mediaPath = /^(live|browser|rtc)\/([0-9a-f]{32})$/
const playbackUserPattern = /^viewer-([0-9a-f]{32})$/
const connectLifetime = 10 * 60_000
const publishLifetime = 12 * 60 * 60_000
const startGrace = 15_000
const browserStartGrace = 30_000
const browserConnectLifetime = 45_000
const browserLease = 105_000
const playbackLease = 45_000
const playbackLimit = 256
const retention = 24 * 60 * 60_000
const viewerLease = 32_000
const playerLimitPerSession = 32

const digest = value => createHash('sha256').update(value).digest()
const asTime = value => new Date(value).toISOString()

function matchDigest(value, expected) {
  return typeof value === 'string' && timingSafeEqual(digest(value), expected)
}

function ingestUrl(site, configured) {
  const scheme = site.protocol === 'https:' ? 'rtmps:' : 'rtmp:'
  const host = scheme === 'rtmp:' && site.hostname === 'localhost' ? '127.0.0.1' : site.hostname
  const destination = new URL(configured || `${scheme}//${host}:${scheme === 'rtmps:' ? 1936 : 1935}`)
  const local = site.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(destination.hostname)
  if (!destination.hostname || destination.username || destination.password ||
      !['', '/'].includes(destination.pathname) || destination.search || destination.hash || destination.port === '0' ||
      (destination.protocol !== 'rtmps:' && !(destination.protocol === 'rtmp:' && local))) {
    throw new Error('STREAM_INGEST_BASE requires an RTMPS server address without a path, or loopback RTMP in development')
  }
  if (!destination.port) destination.port = destination.protocol === 'rtmps:' ? 1936 : 1935
  return destination
}

function mediaOffer(bytes, direction) {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/)
  const media = lines.findIndex(line => line.startsWith('m='))
  if (lines[0] !== 'v=0' || media < 0) return null

  const offer = lines.slice(0, media)
  const tracks = new Set()
  for (let start = media; start < lines.length;) {
    const following = lines.findIndex((line, index) => index > start && line.startsWith('m='))
    const next = following === -1 ? lines.length : following
    const section = lines.slice(start + 1, next)
    const track = /^m=(video|audio) (0|[1-9][0-9]*) UDP\/TLS\/RTP\/SAVPF ([0-9]+(?: [0-9]+)*)$/.exec(lines[start])
    if (!track || tracks.has(track[1]) || !section.includes(`a=${direction}`) ||
        (track[2] === '0' && !section.includes('a=bundle-only'))) return null
    const [, type, port, formats] = track
    tracks.add(type)

    const payloads = formats.split(' ')
    const payloadSet = new Set(payloads)
    if (payloadSet.size !== payloads.length || payloads.some(payload => Number(payload) > 127)) return null
    const codec = type === 'video' ? /^a=rtpmap:([0-9]+) H264\/90000$/i : /^a=rtpmap:([0-9]+) opus\/48000\/2$/i
    const matching = new Set(section.map(line => codec.exec(line)?.[1]).filter(payload => payloadSet.has(payload)))
    const packetized = new Set()
    if (type === 'video') {
      for (const line of section) {
        const parameters = /^a=fmtp:([0-9]+) (.*)$/.exec(line)
        if (parameters?.[2].split(';').some(value => value.trim() === 'packetization-mode=1')) packetized.add(parameters[1])
      }
    }
    const retained = payloads.filter(payload => matching.has(payload) && (type === 'audio' || packetized.has(payload)))
    if (!retained.length) return null
    offer.push(`m=${type} ${port} UDP/TLS/RTP/SAVPF ${retained.join(' ')}`,
      ...section.filter(line => {
        const payload = /^a=(?:rtpmap|fmtp|rtcp-fb):([0-9]+)\s/.exec(line)?.[1]
        return payload === undefined || retained.includes(payload)
      }))
    start = next
  }
  return tracks.has('video') ? offer.join('\r\n') + '\r\n' : null
}

export function createStreams(db, config, {
  requireSession, sessionKey = () => null, isSessionActive = () => false,
  channelAccess, profileFor = () => ({}), readJson, json, RequestError,
}) {
  const site = new URL(config.publicOrigin)
  const ingest = ingestUrl(site, config.ingestBase)
  const mediaApi = new URL(config.mediaApiUrl || 'http://mediamtx:9997')
  const mediaWebrtc = new URL(config.mediaWebrtcUrl || 'http://mediamtx:8889')
  if (!['http:', 'https:'].includes(mediaWebrtc.protocol) || mediaWebrtc.username || mediaWebrtc.password ||
      mediaWebrtc.href !== `${mediaWebrtc.origin}/`) throw new Error('Invalid MediaMTX WebRTC URL')
  const controlKey = randomBytes(32).toString('base64url')
  const controlDigest = digest(controlKey)
  const authorization = `Basic ${Buffer.from(`status:${controlKey}`).toString('base64')}`

  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      key_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      connect_until INTEGER NOT NULL,
      publish_until INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'rtmp' CHECK (mode IN ('rtmp', 'browser')),
      publisher_id TEXT,
      claimed_at INTEGER,
      ended_at INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_broadcast_per_user_channel
      ON broadcasts(channel_id, user_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS broadcast_end ON broadcasts(ended_at);
    CREATE TABLE IF NOT EXISTS stream_playback_relays (id TEXT PRIMARY KEY) STRICT;
  `)
  if (!db.prepare('PRAGMA table_info(broadcasts)').all().some(column => column.name === 'mode')) {
    db.exec("ALTER TABLE broadcasts ADD mode TEXT NOT NULL DEFAULT 'rtmp' CHECK (mode IN ('rtmp', 'browser'))")
  }
  const getBroadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?')
  const getChannel = db.prepare(`
    SELECT broadcasts.*, users.display_name FROM broadcasts JOIN users ON broadcasts.user_id = users.id
    WHERE channel_id = ? AND ended_at IS NULL ORDER BY broadcasts.created_at DESC
  `)
  const getOpen = db.prepare('SELECT * FROM broadcasts WHERE ended_at IS NULL')
  const getRevoked = db.prepare('SELECT * FROM broadcasts WHERE ended_at IS NOT NULL AND publisher_id IS NOT NULL')
  const getVisible = db.prepare(`SELECT b.*, u.display_name, t.id AS topic_id, t.title AS topic_title, c.title AS channel_title
    FROM broadcasts b JOIN channels c ON c.id = b.channel_id JOIN topics t ON t.id = c.topic_id
    JOIN topic_members m ON m.topic_id = t.id AND m.user_id = ? AND m.joined_at IS NOT NULL
    JOIN users u ON u.id = b.user_id
    WHERE b.ended_at IS NULL AND b.publisher_id IS NOT NULL AND b.publish_until > ?
    ORDER BY b.created_at DESC LIMIT 48`)
  const insert = db.prepare(`
    INSERT INTO broadcasts (id, channel_id, user_id, key_hash, created_at, connect_until, publish_until, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `)
  const claim = db.prepare(`
    UPDATE broadcasts SET publisher_id = ?, claimed_at = ?
    WHERE id = ? AND publisher_id IS NULL AND ended_at IS NULL
  `)
  const end = db.prepare('UPDATE broadcasts SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
  const clearPublisher = db.prepare('UPDATE broadcasts SET publisher_id = NULL WHERE id = ? AND ended_at IS NOT NULL')
  const purge = db.prepare('DELETE FROM broadcasts WHERE ended_at < ?')
  const recent = db.prepare('SELECT count(*) AS count FROM broadcasts WHERE user_id = ? AND created_at > ?')
  const viewerName = db.prepare('SELECT id, display_name AS displayName FROM users WHERE id = ?')
  const rememberRelay = db.prepare('INSERT INTO stream_playback_relays (id) VALUES (?)')
  const forgetRelay = db.prepare('DELETE FROM stream_playback_relays WHERE id = ?')
  // A restart revokes the MediaMTX sessions from the previous process.
  const pendingRelayStops = new Set(db.prepare('SELECT id FROM stream_playback_relays').all().map(row => row.id))
  const stoppingRelays = new Set()
  const viewerSessions = new Map()
  const browserPublishers = new Map()
  const playbackSessions = new Map()

  let statusPromise
  let statusDeadline = 0
  let sweeping = false
  let closed = false

  function control(path, method = 'GET') {
    return fetch(new URL(path, mediaApi), {
      method,
      headers: { Authorization: authorization },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })
  }

  async function fetchOnline() {
    const sources = new Set()
    const playback = new Map()
    for (let page = 0, total = 1; page < total; page++) {
      const response = await control(`/v3/paths/list?page=${page}&itemsPerPage=100`)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('MediaMTX status unavailable')
      }
      const result = await response.json()
      total = result.pageCount
      for (const path of result.items) {
        const match = mediaPath.exec(path.name)
        if (!match || (path.online ?? path.ready) !== true) continue
        const [, kind, id] = match
        if (kind === 'browser') {
          sources.add(id)
        } else if (kind === 'live') {
          const hasAudio = path.tracks2?.some(track => ['MPEG-4 Audio', 'Opus'].includes(track.codec)) ?? false
          playback.set(id, hasAudio)
        }
      }
    }
    return { sources, playback }
  }

  function onlineStreams() {
    if (!statusPromise || Date.now() >= statusDeadline) {
      statusDeadline = Number.POSITIVE_INFINITY
      statusPromise = fetchOnline().finally(() => { statusDeadline = Date.now() + 1000 })
    }
    return statusPromise
  }

  function validBroadcast(row, now) {
    if (!row || row.ended_at !== null || row.publish_until <= now ||
        (!row.publisher_id && row.connect_until <= now) || !channelAccess(row.user_id, row.channel_id)?.canStream) return false
    if (row.mode !== 'browser') return true
    const publisher = browserPublishers.get(row.id)
    return publisher?.until > now && isSessionActive(publisher.session, row.user_id)
  }

  function viewingBroadcast(streamId, userId, now) {
    const row = typeof streamId === 'string' && streamIdPattern.test(streamId) && getBroadcast.get(streamId)
    return row?.publisher_id && validBroadcast(row, now) && channelAccess(userId, row.channel_id)?.canView ? row : null
  }

  function validPlayback(playback, now) {
    return playback && playbackSessions.get(playback.id) === playback && playback.until > now &&
      isSessionActive(playback.session, playback.userId) && viewingBroadcast(playback.streamId, playback.userId, now)
  }

  function removePlayback(playback) {
    playbackSessions.delete(playback.id)
    if (playback.relayId) pendingRelayStops.add(playback.relayId)
  }

  function chatChannel(streamId, userId) {
    const row = viewingBroadcast(streamId, userId, Date.now())
    if (!row) throw new RequestError(404, 'Stream nicht gefunden.')
    return row.channel_id
  }

  function pruneViewerLeases(now) {
    for (const [key, players] of viewerSessions) {
      for (const [id, player] of players) if (player.expires <= now) players.delete(id)
      if (!players.size) viewerSessions.delete(key)
    }
  }

  function viewersFor(streamId, ownerId) {
    const row = typeof streamId === 'string' && streamIdPattern.test(streamId) && getBroadcast.get(streamId)
    if (!row || row.user_id !== ownerId || !channelAccess(ownerId, row.channel_id)?.canStream) {
      throw new RequestError(404, 'Stream nicht gefunden.')
    }
    const now = Date.now()
    if (!row.publisher_id || !validBroadcast(row, now)) return []
    const viewers = new Set()
    for (const [key, players] of viewerSessions) {
      for (const player of players.values()) {
        if (player.streamId !== streamId || player.expires <= now || viewers.has(player.userId)) continue
        if (isSessionActive(key, player.userId) && channelAccess(player.userId, row.channel_id)?.canView) {
          viewers.add(player.userId)
        }
      }
    }
    return Array.from(viewers, id => viewerName.get(id)).filter(Boolean)
      .sort((first, second) => first.displayName.localeCompare(second.displayName, 'de') || first.id.localeCompare(second.id))
  }

  async function reportViewer(request, response, streamId) {
    const present = request.method === 'POST'
    if (!present && request.method !== 'DELETE') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    sameOrigin(request)
    requireSession(request)
    const { userId, playerId, revision } = await readJson(request, 512)
    const user = requireSession(request)
    const key = sessionKey(request)
    if (!key || user.id !== userId) throw new RequestError(403, 'Die Wiedergabe gehört zu einer anderen Sitzung.')
    if (typeof playerId !== 'string' || !streamIdPattern.test(playerId) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new RequestError(400, 'Die Wiedergabe ist ungültig.')
    }
    const now = Date.now()
    const row = viewingBroadcast(streamId, user.id, now)
    if (!row) throw new RequestError(404, 'Stream nicht gefunden.')
    if (row.user_id !== user.id) {
      const players = viewerSessions.get(key) ?? new Map()
      const previous = players.get(playerId)
      if (!previous || previous.revision < revision) {
        if (!previous && players.size >= playerLimitPerSession) throw new RequestError(429, 'Zu viele gleichzeitige Wiedergaben.')
        // A release remains as a short tombstone so a delayed heartbeat cannot resurrect a closed player.
        players.set(playerId, { streamId: present ? streamId : null, userId, revision, expires: now + viewerLease })
        viewerSessions.set(key, players)
      }
    }
    response.writeHead(204).end()
    return true
  }

  function closeInvalid(rows, now, online) {
    for (const row of rows) {
      const grace = row.mode === 'browser' ? browserStartGrace : startGrace
      const input = row.mode === 'browser' ? online?.sources : online?.playback
      if (!validBroadcast(row, now) || (row.publisher_id && row.claimed_at + grace <= now && input && !input.has(row.id))) {
        browserPublishers.delete(row.id)
        end.run(now, row.id)
      }
    }
  }

  async function kick(row) {
    if (!row.publisher_id) return
    const firstTransport = ingest.protocol.slice(0, -1)
    const otherTransport = firstTransport === 'rtmp' ? 'rtmps' : 'rtmp'
    const paths = row.mode === 'browser'
      ? [`/v3/webrtc/sessions/kick/${row.publisher_id}`]
      : [firstTransport, otherTransport].map(transport => `/v3/${transport}/conns/kick/${row.publisher_id}`)
    try {
      for (const path of paths) {
        const response = await control(path, 'POST')
        await response.body?.cancel()
        if (response.ok) {
          clearPublisher.run(row.id)
          return
        }
        if (response.status !== 404) return
      }
      clearPublisher.run(row.id)
    } catch {
      // Revocation already blocks HLS and publishing. Retry the disconnect in the next sweep.
    }
  }

  async function flushPlaybackStops() {
    const candidates = [...pendingRelayStops].filter(id => !stoppingRelays.has(id)).slice(0, 24)
    await Promise.all(candidates.map(async id => {
      stoppingRelays.add(id)
      try {
        const response = await control(`/v3/webrtc/sessions/kick/${id}`, 'POST')
        await response.body?.cancel()
        if (response.ok || response.status === 404) {
          if (!closed) forgetRelay.run(id)
          pendingRelayStops.delete(id)
        }
      } catch {
        // Retry during the next sweep.
      } finally {
        stoppingRelays.delete(id)
      }
    }))
  }

  async function sweep() {
    if (sweeping) return
    sweeping = true
    try {
      const open = getOpen.all()
      const online = open.some(row => row.publisher_id) ? await onlineStreams().catch(() => undefined) : undefined
      if (closed) return
      // Re-read after the control request so an incoming publish can claim a pending broadcast safely.
      const now = Date.now()
      pruneViewerLeases(now)
      closeInvalid(getOpen.all(), now, online)
      for (const [id, publisher] of browserPublishers) {
        if (publisher.until <= now || getBroadcast.get(id)?.ended_at !== null) browserPublishers.delete(id)
      }
      for (const playback of playbackSessions.values()) {
        if (!validPlayback(playback, now)) removePlayback(playback)
      }
      await Promise.all([flushPlaybackStops(), ...getRevoked.all().map(kick)])
      if (!closed) purge.run(now - retention)
    } finally {
      sweeping = false
    }
  }

  const ticker = setInterval(() => {
    sweep().catch(() => console.error('Broadcast cleanup failed'))
  }, 5000)
  ticker.unref()

  function canSee(user, channelId) {
    const access = channelAccess(user.id, channelId)
    if (!access?.canView) throw new RequestError(404, 'Live-Channel nicht gefunden.')
    return access
  }

  function sameOrigin(request) {
    if (request.headers.origin !== site.origin) throw new RequestError(403, 'Diese Anfrage ist hier nicht erlaubt.')
  }

  function publicStream(row, live, hasAudio = false) {
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      ...profileFor(row.user_id),
      live,
      hasAudio,
      playlistUrl: `/hls/live/${row.id}/index.m3u8`,
      ...(live ? { whepUrl: `/api/streams/${row.id}/whep` } : {}),
      createdAt: asTime(row.created_at),
    }
  }

  async function homeActivity(userId) {
    if (!getVisible.all(userId, Date.now()).length) return { streams: [], streamsAvailable: true }
    let playback
    try { ({ playback } = await onlineStreams()) } catch { return { streams: [], streamsAvailable: false } }
    const now = Date.now()
    const streams = getVisible.all(userId, now).filter(row => playback.has(row.id) && validBroadcast(row, now)).slice(0, 16)
      .map(row => ({ ...publicStream(row, true, playback.get(row.id)), topicId: row.topic_id, topicTitle: row.topic_title,
        channelId: row.channel_id, channelTitle: row.channel_title }))
    return { streams, streamsAvailable: true }
  }

  async function channelStatus(channelId) {
    let rows = getChannel.all(channelId)
    const online = rows.some(row => row.publisher_id) ? await onlineStreams().catch(() => {
      throw new RequestError(503, 'Der Streamingserver ist gerade nicht erreichbar.')
    }) : { sources: new Set(), playback: new Map() }
    rows = getChannel.all(channelId)
    closeInvalid(rows, Date.now(), online)
    return { rows: getChannel.all(channelId), playback: online.playback }
  }

  async function stopBroadcast(row) {
    browserPublishers.delete(row.id)
    end.run(Date.now(), row.id)
    for (const playback of playbackSessions.values()) {
      if (playback.streamId === row.id) removePlayback(playback)
    }
    await Promise.all([kick(row), flushPlaybackStops()])
  }

  async function sendOffer(path, offer, user, key) {
    try {
      return await fetch(new URL(path, mediaWebrtc), {
        method: 'POST', body: offer, redirect: 'error', signal: AbortSignal.timeout(9000),
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`,
        },
      })
    } catch {
      throw new RequestError(502, 'Der Streamingserver ist gerade nicht erreichbar.')
    }
  }

  function mediaAccepted(result, id) {
    return result.status === 201 && Boolean(id) && result.headers.get('ID') === id &&
      result.headers.get('Content-Type')?.startsWith('application/sdp')
  }

  async function handleWhip(request, response, id) {
    sameOrigin(request)
    const user = requireSession(request)
    const row = getBroadcast.get(id)
    const publisher = browserPublishers.get(id)
    if (!row || row.mode !== 'browser' || row.user_id !== user.id || !publisher || publisher.session !== sessionKey(request)) {
      throw new RequestError(404, 'Stream nicht gefunden.')
    }
    if (request.method === 'DELETE') {
      await stopBroadcast(row)
      response.writeHead(204).end()
      return true
    }
    if (!validBroadcast(row, Date.now())) throw new RequestError(404, 'Stream nicht gefunden.')
    if (request.method === 'PATCH' && publisher.negotiated) {
      publisher.until = Date.now() + browserLease
      response.writeHead(204).end()
      return true
    }
    if (request.method !== 'POST') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    if (publisher.negotiating || publisher.negotiated) {
      throw new RequestError(409, 'Du hast hier bereits einen Stream vorbereitet oder gestartet.')
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/sdp') {
      throw new RequestError(415, 'Eine SDP-Verbindungsanfrage wird erwartet.')
    }

    publisher.negotiating = true
    try {
      const bytes = await readBytes(request, 48 * 1024)
      let offer
      try { offer = mediaOffer(bytes, 'sendonly') } catch { /* malformed SDP */ }
      if (!offer) throw new RequestError(400, 'Der Browser-Stream benötigt H.264-Video und optional Opus-Audio.')
      if (response.destroyed || !validBroadcast(getBroadcast.get(id), Date.now())) {
        throw new RequestError(404, 'Stream nicht gefunden.')
      }
      const result = await sendOffer(`/browser/${id}/whip`, offer, 'browser', publisher.key)
      if (!mediaAccepted(result, getBroadcast.get(id)?.publisher_id)) {
        await result.body?.cancel()
        throw new RequestError(502, 'Der Streamingserver ist gerade nicht erreichbar.')
      }
      const answer = await result.text()
      if (response.destroyed || !validBroadcast(getBroadcast.get(id), Date.now())) {
        throw new RequestError(404, 'Stream nicht gefunden.')
      }
      publisher.until = Date.now() + browserLease
      publisher.negotiated = true
      response.writeHead(201, {
        'Content-Type': 'application/sdp',
        Location: `/api/streams/${id}/whip`,
      }).end(answer)
      return true
    } finally {
      publisher.negotiating = false
      delete publisher.key
      if (!publisher.negotiated) await stopBroadcast(getBroadcast.get(id))
    }
  }

  async function handleWhep(request, response, streamId, playbackId) {
    sameOrigin(request)
    const user = requireSession(request)
    const session = sessionKey(request)
    const missing = () => new RequestError(404, 'Stream nicht gefunden.')
    if (!session) throw missing()

    if (playbackId) {
      const playback = playbackSessions.get(playbackId)
      if (!playback || playback.session !== session || playback.userId !== user.id || playback.streamId !== streamId) throw missing()
      if (request.method === 'DELETE' || !validPlayback(playback, Date.now())) {
        removePlayback(playback)
        await flushPlaybackStops()
        if (request.method !== 'DELETE') throw missing()
      } else if (request.method === 'PATCH' && playback.negotiated) {
        playback.until = Date.now() + playbackLease
      } else {
        throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
      }
      response.writeHead(204).end()
      return true
    }

    if (request.method !== 'POST') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    if (!viewingBroadcast(streamId, user.id, Date.now())) throw missing()
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/sdp') {
      throw new RequestError(415, 'Eine SDP-Verbindungsanfrage wird erwartet.')
    }
    const bytes = await readBytes(request, 48 * 1024)
    let offer
    try { offer = mediaOffer(bytes, 'recvonly') } catch { /* malformed SDP */ }
    if (!offer) throw new RequestError(400, 'Die Wiedergabe benötigt H.264-Video und optional Opus-Audio.')
    const row = viewingBroadcast(streamId, user.id, Date.now())
    if (response.destroyed || !row || !isSessionActive(session, user.id)) throw missing()
    let sessionCount = 0
    for (const playback of playbackSessions.values()) if (playback.session === session) sessionCount += 1
    if (sessionCount >= playerLimitPerSession || playbackSessions.size + pendingRelayStops.size >= playbackLimit) {
      throw new RequestError(429, 'Zu viele gleichzeitige Wiedergaben.')
    }
    const id = randomBytes(16).toString('hex')
    const key = randomBytes(32).toString('hex')
    const playback = {
      id, session, userId: user.id, streamId, kind: row.mode === 'browser' ? 'browser' : 'rtc',
      keyHash: digest(key), until: Date.now() + playbackLease,
    }
    playbackSessions.set(id, playback)
    try {
      const result = await sendOffer(`/${playback.kind}/${streamId}/whep`, offer, `viewer-${id}`, key)
      if (!mediaAccepted(result, playback.relayId)) {
        await result.body?.cancel()
        throw new RequestError(502, 'Der Streamingserver ist gerade nicht erreichbar.')
      }
      const answer = await result.text()
      if (response.destroyed || !validPlayback(playback, Date.now())) throw missing()
      playback.negotiated = true
      playback.until = Date.now() + playbackLease
      response.writeHead(201, {
        'Content-Type': 'application/sdp',
        Location: `/api/streams/${streamId}/whep/${id}`,
      }).end(answer)
      return true
    } finally {
      delete playback.keyHash
      if (!playback.negotiated) {
        removePlayback(playback)
        await flushPlaybackStops()
      }
    }
  }

  async function handle(request, response, pathname) {
    const viewer = streamViewersPath.exec(pathname)
    if (viewer) return reportViewer(request, response, viewer[1])
    const whip = streamWhipPath.exec(pathname)
    if (whip) return handleWhip(request, response, whip[1])
    const whep = streamWhepPath.exec(pathname)
    if (whep) return handleWhep(request, response, whep[1], whep[2])
    const channel = channelStreamsPath.exec(pathname)
    const remove = streamPath.exec(pathname)
    if (!channel && !remove) return false
    const user = requireSession(request)
    if (channel && request.method === 'GET') {
      const channelId = channel[1]
      canSee(user, channelId)
      const { rows, playback } = await channelStatus(channelId)
      const access = canSee(requireSession(request), channelId)
      const streams = rows.filter(row => playback.has(row.id) || row.user_id === user.id)
        .map(row => publicStream(row, playback.has(row.id), playback.get(row.id)))
      json(response, 200, { streams, canStream: Boolean(access.canStream) })
      return true
    }
    if (channel && request.method === 'POST') {
      const channelId = channel[1]
      sameOrigin(request)
      if (!canSee(user, channelId).canStream) throw new RequestError(403, 'Du darfst in diesem Channel nicht streamen.')
      const { mode = 'rtmp' } = await readJson(request)
      if (mode !== 'rtmp' && mode !== 'browser') throw new RequestError(400, 'Ungültige Auswahl.')
      await channelStatus(channelId)
      if (!canSee(requireSession(request), channelId).canStream) {
        throw new RequestError(403, 'Du darfst in diesem Channel nicht streamen.')
      }
      const now = Date.now()
      if (recent.get(user.id, now - 60_000).count >= 5) throw new RequestError(429, 'Warte kurz vor einer weiteren Stream-Anfrage.')
      const id = randomBytes(16).toString('hex')
      const key = randomBytes(32).toString('hex')
      const session = mode === 'browser' ? sessionKey(request) : null
      if (mode === 'browser' && !session) throw new RequestError(404, 'Stream nicht gefunden.')
      const connectUntil = now + (mode === 'browser' ? browserConnectLifetime : connectLifetime)
      if (!insert.run(id, channelId, user.id, digest(key), now, connectUntil, now + publishLifetime, mode).changes) {
        throw new RequestError(409, 'Du hast hier bereits einen Stream vorbereitet oder gestartet.')
      }
      const stream = publicStream({ id, user_id: user.id, display_name: user.displayName, created_at: now }, false)
      if (mode === 'browser') {
        browserPublishers.set(id, { session, key, until: connectUntil })
        json(response, 201, { stream, whipUrl: `/api/streams/${id}/whip`, iceServers: [] })
        return true
      }
      const address = new URL(`/live/${id}`, ingest).href
      json(response, 201, { stream, address, key, expiresAt: asTime(connectUntil) })
      return true
    }
    if (remove && request.method === 'DELETE') {
      sameOrigin(request)
      const row = getBroadcast.get(remove[1])
      if (!row || (row.user_id !== user.id && !channelAccess(user.id, row.channel_id)?.canManage)) {
        throw new RequestError(404, 'Stream nicht gefunden.')
      }
      await stopBroadcast(row)
      response.writeHead(204).end()
      return true
    }
    throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
  }

  async function handleMedia(request, response, pathname, data) {
    if (request.method !== 'POST' || pathname !== '/internal/media-auth') return false
    const auth = data ?? await readJson(request)
    if (auth?.action === 'api' && auth.user === 'status' && matchDigest(auth.password, controlDigest)) {
      response.writeHead(200).end()
      return true
    }
    const match = typeof auth?.path === 'string' && mediaPath.exec(auth.path)
    const row = match && getBroadcast.get(match[2])
    const now = Date.now()
    if (validBroadcast(row, now)) {
      const kind = match[1]
      const isPlayback = kind === 'live'
      const browser = row.mode === 'browser'
      const relay = row.publisher_id && auth.protocol === 'rtsp' && auth.ip === '127.0.0.1' && (browser
        ? (kind === 'browser' && auth.action === 'read') || (isPlayback && auth.action === 'publish')
        : (isPlayback && auth.action === 'read') || (kind === 'rtc' && auth.action === 'publish'))
      if ((isPlayback && auth.action === 'read' && auth.protocol === 'hls' && row.publisher_id) || relay) {
        response.writeHead(200).end()
        return true
      }
      if (auth.action === 'read' && auth.protocol === 'webrtc' && typeof auth.user === 'string') {
        const viewer = playbackUserPattern.exec(auth.user)
        const playback = viewer && playbackSessions.get(viewer[1])
        if (playback?.keyHash && !playback.relayId && playback.streamId === row.id && playback.kind === kind &&
            typeof auth.id === 'string' && connectionIdPattern.test(auth.id) && matchDigest(auth.password, playback.keyHash) &&
            validPlayback(playback, now)) {
          rememberRelay.run(auth.id)
          playback.relayId = auth.id
          json(response, 200, { expireAt: asTime(row.publish_until) })
          return true
        }
      }
      const nativePublisher = isPlayback && !browser && auth.protocol === 'rtmp' && auth.user === 'streamer'
      const browserPublisher = kind === 'browser' && browser && auth.protocol === 'webrtc' && auth.user === 'browser' &&
        browserPublishers.get(row.id)?.negotiating
      if (auth.action === 'publish' && (nativePublisher || browserPublisher) &&
          typeof auth.id === 'string' && connectionIdPattern.test(auth.id) && matchDigest(auth.password, row.key_hash) &&
          ((nativePublisher && row.publisher_id === auth.id) || (!row.publisher_id && claim.run(auth.id, now, row.id).changes))) {
        json(response, 200, { expireAt: asTime(row.publish_until) })
        return true
      }
    }
    response.writeHead(401).end()
    return true
  }

  function checkViewer(request, response) {
    const actor = requireSession(request)
    const access = viewingBroadcast(request.headers['x-stream-id'], actor.id, Date.now())
    response.writeHead(access ? 204 : 403).end()
  }

  function close() {
    closed = true
    clearInterval(ticker)
    for (const playback of playbackSessions.values()) removePlayback(playback)
    if (pendingRelayStops.size) void flushPlaybackStops()
  }

  return { handle, handleMedia, checkViewer, homeActivity, viewersFor, chatChannel, close }
}
