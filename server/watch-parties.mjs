import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { json, readBytes, readJson, RequestError } from './http.mjs'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const watchRoute = new RegExp(`^/api/channels/(${uuid})/watch(?:/(${uuid})(?:/(upload|media|metadata))?)?$`, 'u')
const storedName = new RegExp(`^${uuid}\\.video$`, 'u')
const youtubeId = /^[\w-]{11}$/u
const videoTypes = new Map([['video/mp4', 'video.mp4'], ['video/webm', 'video.webm']])
const chunkSize = 4 * 1024 ** 2
const maxFileSize = 256 * 1024 ** 2
const maxStorage = 512 * 1024 ** 2
const maxParties = 8
const maxUploadRequests = 4
const maxMediaReads = 128
const maxMediaReadsPerSession = 8
const uploadIdleTime = 3 * 60_000
const uploadLifetime = 20 * 60_000
const partyLifetime = 12 * 60 * 60_000
const maxPosition = 7 * 24 * 60 * 60
const watchPath = (channel, party) => `/api/channels/${channel}/watch/${party}`
const missing = () => new RequestError(404, 'Keine Watchparty gefunden.')
const tooBusy = () => new RequestError(429, 'Warte einen Moment, bevor du es erneut versuchst.')
const conflict = () => new RequestError(409, 'Die Watchparty wurde inzwischen geändert.')
const unsupported = () => new RequestError(415, 'Wähle ein Video im MP4- oder WebM-Format.')
const positionAt = (party, time) => Math.min(maxPosition, party.position + (party.playing ? (time - party.updatedAt) / 1000 : 0))
const validPosition = position => Number.isFinite(position) && position >= 0 && position <= maxPosition

function watchTitle(value, source) {
  if (typeof value !== 'string') return ''
  const title = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ')
  return [...(source === 'local' ? title.replace(/[\\/]/gu, ' ') : title).trim()].slice(0, 120).join('')
}

function isVideo(bytes, mime) {
  if (bytes.length < 16) return false
  if (mime === 'video/mp4') {
    const boxLength = bytes.readUInt32BE(0)
    return boxLength >= 16 && boxLength <= 4096 && boxLength <= bytes.length &&
      bytes.toString('ascii', 4, 8) === 'ftyp'
  }
  if (bytes.readUInt32BE(0) !== 0x1a45dfa3) return false
  const sizeByte = bytes[4]
  const width = Math.clz32(sizeByte) - 23
  if (width < 1 || width > 3) return false
  let length = sizeByte & (255 >> width)
  for (let index = 1; index < width; index++) length = 256 * length + bytes[4 + index]
  const end = 4 + width + length
  return end <= Math.min(bytes.length, 4096) &&
    bytes.subarray(4 + width, end).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))
}

function mediaRange(header, size) {
  if (header === undefined) return { start: 0, end: size - 1, partial: false }
  const parts = typeof header === 'string' && /^bytes=(\d{0,16})-(\d{0,16})$/iu.exec(header)
  if (!parts || (!parts[1] && !parts[2])) return null
  const start = parts[1] ? Number(parts[1]) : Math.max(0, size - Number(parts[2]))
  const end = parts[1] && parts[2] ? Math.min(size - 1, Number(parts[2])) : size - 1
  if (start >= size || end < start) return null
  return { start, end, partial: true }
}

export function createWatchParties({ dataDir, requireSession, sessionKey, isSessionActive, channelAccess,
  isTemporaryChannel = () => false, assertTemporarySource = () => {}, noteTemporarySource = () => {},
  now = () => Math.floor(performance.timeOrigin + performance.now()) }) {
  const folder = join(dataDir, 'watch-videos')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(folder)) {
    if (storedName.test(name)) unlinkSync(join(folder, name))
  }

  const parties = new Map()
  const retiredFiles = new Set()
  const starts = new Map()
  const reads = new Set()
  let reservedBytes = 0
  let uploadRequests = 0
  let closing = false

  function accessTo(actor, channelId) {
    const access = channelAccess(actor.id, channelId)
    if (!access?.canView) throw missing()
    return access
  }

  function removeFile(party) {
    if (party.uploading || party.deleting) return
    party.deleting = true
    unlink(party.file).catch(error => {
      if (error.code !== 'ENOENT') throw error
    }).then(() => {
      retiredFiles.delete(party)
      reservedBytes -= party.size
    }, error => {
      if (!party.cleanupError) console.error('Watch party cleanup failed', error.code ?? error.name)
      party.cleanupError = true
    }).finally(() => { party.deleting = false })
  }

  function retire(party) {
    if (parties.get(party.channelId) !== party) return
    parties.delete(party.channelId)
    for (const read of reads) {
      if (read.party === party) read.abort.abort()
    }
    if (party.file) {
      retiredFiles.add(party)
      removeFile(party)
    }
  }

  function activeParty(channelId, time) {
    const party = parties.get(channelId)
    if (!party) return null
    if (party.expiresAt <= time || (party.state === 'uploading' && party.uploadUntil <= time) ||
        !isSessionActive(party.hostSession, party.hostId) || !channelAccess(party.hostId, channelId)?.canStream) {
      retire(party)
      return null
    }
    return party
  }

  function sweep() {
    const time = now()
    for (const [id, start] of starts) {
      if (start.expires <= time) starts.delete(id)
    }
    for (const channel of parties.keys()) activeParty(channel, time)
    for (const file of retiredFiles) removeFile(file)
    for (const read of reads) {
      if (!read.isActive()) read.abort.abort()
    }
  }

  function playbackState(party) {
    return { id: party.id, source: party.source, title: party.title,
      position: party.position, playing: party.playing, updatedAt: party.updatedAt, revision: party.revision }
  }

  function snapshot(actor, access, party, time) {
    const canStop = Boolean(party && (party.hostId === actor.id || access.canManage))
    const visible = party && (party.state === 'ready' || canStop)
    return { party: visible ? {
      ...playbackState(party), hostId: party.hostId, state: party.state,
      ...(party.source === 'youtube' ? { videoId: party.videoId } : { mime: party.mime,
        ...(party.state === 'uploading' ? { offset: party.offset, size: party.size } :
          { mediaUrl: `${watchPath(party.channelId, party.id)}/media` }) }),
    } : null, serverTime: time, canShare: Boolean(access.canStream), canStop }
  }

  function homeActivity(userId) {
    const entries = []
    const time = now()
    for (const channelId of parties.keys()) {
      if (isTemporaryChannel(channelId)) continue
      const party = activeParty(channelId, time)
      if (party?.state !== 'ready') continue
      const access = channelAccess(userId, channelId)
      if (!access?.canView) continue
      const { topicId, topicTitle, channelTitle } = access
      entries.push({ id: party.id, source: party.source, title: party.title, topicId, topicTitle, channelId, channelTitle })
    }
    return entries
  }

  function hasGuestSource(channelId, ownerId) {
    return activeParty(channelId, now())?.hostId === ownerId
  }

  function guestParty(scope, time) {
    if (!isTemporaryChannel(scope.channelId) || !['youtube', 'local'].includes(scope.source)) return null
    const party = activeParty(scope.channelId, time)
    return party?.state === 'ready' && party.hostId === scope.ownerId && party.source === scope.source ? party : null
  }

  function guestSnapshot(scope) {
    const serverTime = now()
    const party = guestParty(scope, serverTime)
    return { serverTime, party: party ? {
      ...playbackState(party), ...(party.source === 'youtube' ? { videoId: party.videoId } : {
        mime: party.mime, mediaUrl: `/api/guest/${scope.roomId}/media/${party.id}`,
      }),
    } : null }
  }

  function specificParty(channelId, id, time) {
    const party = activeParty(channelId, time)
    if (party?.id !== id) throw missing()
    return party
  }

  function chargeStart(userId, time) {
    let budget = starts.get(userId)
    if (!budget || budget.expires <= time) {
      if (!budget && starts.size >= 4096) throw tooBusy()
      budget = { count: 0, expires: time + 60_000 }
      starts.set(userId, budget)
    }
    if (budget.count >= 4) throw tooBusy()
    budget.count++
  }

  async function start(request, response, actor, channelId) {
    if (!accessTo(actor, channelId).canStream) throw new RequestError(403, 'Du darfst in diesem Channel nicht streamen.')
    const { source, videoId, mime, size, title } = await readJson(request)
    if (source !== 'youtube' && source !== 'local') throw new RequestError(400, 'Ungültige Auswahl.')
    if (source === 'youtube' && (typeof videoId !== 'string' || !youtubeId.test(videoId))) {
      throw new RequestError(400, 'Ungültige YouTube-Video-ID.')
    }
    if (source === 'local') {
      if (!videoTypes.has(mime)) throw unsupported()
      if (!Number.isSafeInteger(size) || size < 16) throw new RequestError(400, 'Ungültige Videodatei.')
      if (size > maxFileSize) throw new RequestError(413, 'Das Video darf höchstens 256 MiB groß sein.')
    }
    const current = requireSession(request)
    const access = accessTo(current, channelId)
    if (current.id !== actor.id || !access.canStream) throw new RequestError(403, 'Du darfst in diesem Channel nicht streamen.')
    sweep()
    const time = now()
    if (parties.has(channelId)) {
      throw new RequestError(409, 'In diesem Channel läuft bereits eine Watchparty.')
    }
    if (parties.size >= maxParties || (source === 'local' && reservedBytes + size > maxStorage)) {
      throw new RequestError(503, 'Es ist gerade kein Platz für eine weitere Watchparty frei.')
    }
    assertTemporarySource(channelId, current.id, source)
    chargeStart(current.id, time)
    const id = randomUUID()
    const party = { id, channelId, hostId: current.id, hostSession: sessionKey(request), source,
      title: source === 'local' ? watchTitle(title, source) : '',
      playing: false, position: 0, updatedAt: time, revision: 1,
      commandWindowUntil: time, commandCount: 0,
      ...(source === 'youtube' ? { videoId, state: 'ready', expiresAt: time + partyLifetime } : {
        mime, size, state: 'uploading', expiresAt: time + uploadLifetime,
        uploadUntil: time + uploadIdleTime, file: join(folder, `${id}.video`), offset: 0,
      }),
    }
    if (party.file) reservedBytes += size
    parties.set(channelId, party)
    try {
      noteTemporarySource(channelId, current.id)
    } catch (error) {
      retire(party)
      throw error
    }
    return json(response, 201, snapshot(current, access, party, time))
  }

  function assertUploader(request, actor, party) {
    if (party.state !== 'uploading' || party.hostId !== actor.id || party.hostSession !== sessionKey(request)) throw missing()
  }

  async function addMetadata(request, response, actor, party) {
    const allowed = user => party.source === 'youtube' && party.hostId === user.id && party.hostSession === sessionKey(request)
    if (!allowed(actor)) throw missing()
    const { title } = await readJson(request, 1024)
    const cleaned = watchTitle(title, party.source)
    if (!cleaned) throw new RequestError(400, 'Ungültiger Videotitel.')
    const current = requireSession(request)
    if (!allowed(current)) throw missing()
    const access = accessTo(current, party.channelId)
    const time = now()
    specificParty(party.channelId, party.id, time)
    if (party.title && party.title !== cleaned) throw conflict()
    party.title = cleaned
    return json(response, 200, snapshot(current, access, party, time))
  }

  async function upload(request, response, url, actor, party) {
    assertUploader(request, actor, party)
    if (request.headers['content-type'] !== 'application/octet-stream') throw unsupported()
    const rawOffset = url.searchParams.get('offset')
    if (url.searchParams.size !== 1 || rawOffset === null || !/^\d{1,9}$/u.test(rawOffset) || Number(rawOffset) !== party.offset) {
      throw conflict()
    }
    if (party.uploading || uploadRequests >= maxUploadRequests) throw tooBusy()
    const offset = party.offset
    const length = Math.min(chunkSize, party.size - offset)
    party.uploading = true
    uploadRequests++
    try {
      const bytes = await readBytes(request, length)
      if (bytes.length !== length) throw new RequestError(400, 'Ungültiger Videoabschnitt.')
      if (offset === 0 && !isVideo(bytes, party.mime)) {
        retire(party)
        throw unsupported()
      }
      const current = requireSession(request)
      const access = accessTo(current, party.channelId)
      specificParty(party.channelId, party.id, now())
      assertUploader(request, current, party)
      try {
        const file = await open(party.file, offset ? constants.O_WRONLY | constants.O_NOFOLLOW : 'wx', 0o600)
        try {
          for (let written = 0; written < bytes.length;) {
            const { bytesWritten } = await file.write(bytes, written, bytes.length - written, offset + written)
            if (!bytesWritten) throw new Error('Incomplete watch party file write')
            written += bytesWritten
          }
        } finally {
          await file.close()
        }
      } catch (error) {
        retire(party)
        if (error.code === 'ENOSPC' || error.code === 'EDQUOT') throw new RequestError(507, 'Der Speicher für Videos ist voll.')
        throw error
      }
      const time = now()
      specificParty(party.channelId, party.id, time)
      party.offset += length
      const complete = party.offset === party.size
      if (complete) {
        Object.assign(party, { state: 'ready', updatedAt: time, expiresAt: time + partyLifetime, revision: party.revision + 1 })
      } else party.uploadUntil = time + uploadIdleTime
      return json(response, 200, { ...snapshot(current, access, party, time), offset: party.offset, complete })
    } finally {
      party.uploading = false
      uploadRequests--
      if (retiredFiles.has(party)) removeFile(party)
    }
  }

  async function serve(request, response, party, { key, verifyAccess, isActive }) {
    if (party.state !== 'ready' || !party.file) throw missing()
    const range = mediaRange(request.headers.range, party.size)
    const headers = { 'Accept-Ranges': 'bytes' }
    if (!range) return response.writeHead(416, { ...headers, 'Content-Range': `bytes */${party.size}` }).end()
    const wantsBody = request.method !== 'HEAD'
    if (wantsBody && (reads.size >= maxMediaReads || [...reads].filter(read => read.session === key).length >= maxMediaReadsPerSession)) {
      throw tooBusy()
    }
    const { start, end, partial } = range
    const read = { party, session: key, isActive, abort: new AbortController() }
    if (wantsBody) reads.add(read)
    let file
    try {
      file = await open(party.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
        if (error.code === 'ENOENT') throw missing()
        throw error
      })
      verifyAccess()
      specificParty(party.channelId, party.id, now())
      if (response.destroyed) return
      if (read.abort.signal.aborted) throw missing()
      response.writeHead(partial ? 206 : 200, { ...headers,
        'Content-Type': party.mime, 'Content-Length': end - start + 1,
        'Content-Disposition': `inline; filename="${videoTypes.get(party.mime)}"`,
        ...(partial && { 'Content-Range': `bytes ${start}-${end}/${party.size}` }),
      })
      if (!wantsBody) return response.end()
      await pipeline(file.createReadStream({ start, end }), response, { signal: read.abort.signal })
    } finally {
      reads.delete(read)
      await file?.close()
    }
  }

  function serveMemberMedia(request, response, actor, party) {
    const key = sessionKey(request)
    return serve(request, response, party, { key,
      verifyAccess() {
        if (requireSession(request).id !== actor.id) throw missing()
        accessTo(actor, party.channelId)
      },
      isActive: () => isSessionActive(key, actor.id) && channelAccess(actor.id, party.channelId)?.canView,
    })
  }

  function serveGuestMedia(request, response, scope, partyId, isActive) {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    const party = guestParty(scope, now())
    if (party?.id !== partyId || party.source !== 'local' || !isActive()) throw missing()
    const key = scope.guestKey.session ?? `guest:${scope.guestKey.token}`
    return serve(request, response, party, { key, isActive, verifyAccess() { if (!isActive()) throw missing() } })
  }

  async function control(request, response, actor, party) {
    const { action, revision, position } = await readJson(request)
    if (!['play', 'pause', 'seek'].includes(action) || !Number.isSafeInteger(revision) || revision < 1 ||
        ((action === 'seek' || position !== undefined) && (!['seek', 'play'].includes(action) || !validPosition(position)))) {
      throw new RequestError(400, 'Ungültige Videosteuerung.')
    }
    const current = requireSession(request)
    if (current.id !== actor.id) throw missing()
    const access = accessTo(current, party.channelId)
    const time = now()
    specificParty(party.channelId, party.id, time)
    if (party.state !== 'ready' || party.revision !== revision) throw conflict()
    if (party.commandWindowUntil <= time) {
      party.commandWindowUntil = time + 1000
      party.commandCount = 0
    }
    if (party.commandCount >= 12) throw tooBusy()
    party.position = position ?? positionAt(party, time)
    if (action !== 'seek') party.playing = action === 'play'
    party.updatedAt = time
    party.commandCount++
    party.revision++
    return json(response, 200, snapshot(current, access, party, time))
  }

  const timer = setInterval(sweep, 5000)
  timer.unref()

  async function handle(request, response, url) {
    const route = watchRoute.exec(url.pathname)
    if (!route) return false
    if (closing) throw missing()
    const [, channelId, partyId, resource] = route
    const actor = requireSession(request)
    const access = accessTo(actor, channelId)
    const method = request.method
    const time = now()
    if (!partyId && method === 'GET') json(response, 200, snapshot(actor, access, activeParty(channelId, time), time))
    else if (!partyId && method === 'POST') await start(request, response, actor, channelId)
    else if (partyId) {
      const party = specificParty(channelId, partyId, time)
      if (resource === 'media' && (method === 'GET' || method === 'HEAD')) await serveMemberMedia(request, response, actor, party)
      else if (resource === 'upload' && method === 'PUT') await upload(request, response, url, actor, party)
      else if (resource === 'metadata' && method === 'PATCH') await addMetadata(request, response, actor, party)
      else if (!resource && method === 'PATCH') await control(request, response, actor, party)
      else if (!resource && method === 'DELETE') {
        if (party.hostId !== actor.id && !access.canManage) throw missing()
        retire(party)
        json(response, 200, snapshot(actor, access, null, now()))
      } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    return true
  }

  function close() {
    closing = true
    clearInterval(timer)
    for (const party of parties.values()) retire(party)
  }

  return { handle, homeActivity, hasGuestSource, guestSnapshot, serveGuestMedia, close }
}
