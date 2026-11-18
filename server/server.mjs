import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAppearance } from './appearance.mjs'
import { bootstrapOwnerInvite, createAuth, requestAddress } from './auth.mjs'
import { createCommunity } from './community.mjs'
import { createChannelManagement } from './channel-management.mjs'
import { createDesktopHandoff } from './desktop-handoff.mjs'
import { createHistory } from './history.mjs'
import { assertOrigin, json, readJson, RequestError } from './http.mjs'
import { setResponseLocale } from './locale.mjs'
import { createNotifications } from './notifications.mjs'
import { createPresence } from './presence.mjs'
import { createQuickRooms } from './quick-rooms.mjs'
import { createReactions } from './reactions.mjs'
import { createStreams } from './streams.mjs'
import { createStreamChat } from './stream-chat.mjs'
import { createTutorials } from './tutorials.mjs'
import { createVoice } from './voice.mjs'
import { createWatchParties } from './watch-parties.mjs'
import { configuredSetupKey, createSetup } from './setup.mjs'

const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080')
const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
const host = process.env.HOST ?? '0.0.0.0'
const trustExternalProxy = process.env.TRUST_PROXY_IP === '1'
const trustProxyIp = trustExternalProxy || (process.env.TRUST_GATEWAY_IP === '1' && host === '127.0.0.1')
if ((origin.protocol !== 'https:' && (!localHttp || trustExternalProxy)) || origin.href !== `${origin.origin}/`) {
  throw new Error('PUBLIC_ORIGIN must be an HTTPS address or a local test address.')
}

process.umask(0o077)
const dataDir = process.env.APP_DATA_DIR ?? '/data'
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
// SQLite needs writable scratch space for cascading deletes on a read-only container filesystem.
process.env.SQLITE_TMPDIR ??= dataDir
const db = new DatabaseSync(join(dataDir, 'community.sqlite'), { timeout: 5000 })
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 67108864')
const appearance = createAppearance(db)
const profileFor = appearance.profile
const desktopHandoff = createDesktopHandoff()
const auth = createAuth(db, { publicOrigin: origin.origin, trustProxyIp, profileFor: appearance.selfProfile,
  revokeBroadcasts: userId => streams.revokeUser(userId) })
const { requireSession } = auth
const setup = createSetup(db, { publicOrigin: origin.origin, setupKey: configuredSetupKey(db),
  ipFor: request => requestAddress(request, trustProxyIp),
  bootstrap: () => bootstrapOwnerInvite(db, origin.origin, { browserSetup: true }) })
const tutorials = createTutorials(db, { requireSession })
const recordMentions = input => notifications.recordMentions(input)
const community = createCommunity(db, { requireSession, appearance, recordMentions,
  recordFriendRequest: input => notifications.recordFriendRequest(input),
  recordDirectMessage: input => notifications.recordDirectMessage(input),
  recordDirectRead: input => notifications.recordDirectRead(input),
  updateMovedMention: input => notifications.updateMovedMention(input),
  requeueMovedHistory: input => history.requeueMovedHistory(input),
})
const temporaryChannels = {
  isTemporaryChannel: channelId => quickRooms.isTemporaryChannel(channelId),
  assertTemporarySource: (channelId, userId, source) => quickRooms.assertTemporarySource(channelId, userId, source),
  noteTemporarySource: (channelId, userId) => quickRooms.noteTemporarySource(channelId, userId),
}
const channelManagement = createChannelManagement(db, { requireSession, isTemporaryTopic: topicId => quickRooms.isTemporaryTopic(topicId) })
const presence = createPresence(db, auth)
const watchParties = createWatchParties({ ...auth, ...temporaryChannels, dataDir: process.env.WATCH_MEDIA_DIR || dataDir,
  channelAccess: community.channelAccess })
const history = createHistory(db, { requireSession })
const streams = createStreams(db, {
  ...temporaryChannels,
  publicOrigin: origin.origin, ingestBase: process.env.STREAM_INGEST_BASE, mediaApiUrl: process.env.MEDIAMTX_API_URL,
  mediaWebrtcUrl: process.env.MEDIAMTX_WEBRTC_URL, onLive: input => notifications.recordLive(input),
}, { requireSession, sessionKey: auth.sessionKey, isSessionActive: auth.isSessionActive,
  channelAccess: community.channelAccess, profileFor, readJson, json, RequestError })
const quickRooms = createQuickRooms(db, { publicOrigin: origin.origin, trustProxyIp, auth, community, streams, watchParties })
const streamChat = createStreamChat(db, { requireSession, community, streams, profileFor, recordMentions })
const notifications = createNotifications(db, { requireSession, streams, profileFor, notifyLive: appearance.notifyLive })
const reactions = createReactions(db, { requireSession, streams, assertChatWritable: community.assertChatWritable })
const voice = createVoice(db, { mediaUrl: process.env.MEDIAMTX_WEBRTC_URL }, {
  requireSession, sessionKey: auth.sessionKey, isSessionActive: auth.isSessionActive,
  channelAccess: (userId, channelId) => quickRooms.isTemporaryChannel(channelId) ? null : community.channelAccess(userId, channelId),
  profileFor, readJson, json, RequestError,
})

function service(handler) {
  const server = createServer({ headersTimeout: 5000, requestTimeout: 30000, connectionsCheckingInterval: 1000 },
    async (request, response) => {
      setResponseLocale(request, response)
      response.setHeader('Cache-Control', 'private, no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      try {
        await handler(request, response)
      } catch (error) {
        if (response.destroyed) return
        if (response.headersSent) return response.destroy()
        if (error instanceof RequestError) {
          const headers = request.complete ? {} : { Connection: 'close' }
          if (error.code === 'ROOMS_ACCOUNT_CHANGED') headers['X-Rooms-Error'] = 'account-changed'
          const knownCode = ['ROOMS_ACCOUNT_CHANGED', 'ROOMS_OWNER_CODE', 'ROOMS_OWNER_APPROVAL', 'ROOMS_MFA_CODE'].includes(error.code)
          json(response, error.status, { error: error.message, ...(knownCode && { code: error.code }) }, headers)
        } else {
          console.error('Request failed', error.code ?? error.name)
          json(response, 500, { error: 'Die Anfrage konnte nicht verarbeitet werden.' })
        }
      }
    })
  server.maxConnections = 512
  return server
}

const publicApi = service(async (request, response) => {
  const url = new URL(request.url, 'http://gateway')
  const path = url.pathname
  if (request.method === 'GET' && path === '/api/health') return json(response, 200, { ok: true })
  if (request.method === 'GET' && path === '/api/desktop/instance') {
    const nonce = url.searchParams.get('nonce')
    if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return json(response, 400, { error: 'Invalid nonce' })
    return json(response, 200, { product: 'zelotez-rooms', protocol: 1, origin: origin.origin, nonce, handoffReceipt: 1 })
  }
  if (path === '/api/desktop/handoff') return desktopHandoff.handle(request, response)
  if (request.method === 'GET' && path === '/_internal/stream-view') return streams.checkViewer(request, response)
  if (request.method === 'GET' && path === '/_internal/guest-stream-view') return quickRooms.checkGuestViewer(request, response)
  if (path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) assertOrigin(request, origin.origin)
    if (await setup.handle(request, response, path)) return
    if (path.startsWith('/api/guest/')) {
      if (await quickRooms.handleGuest(request, response, path)) return
      return json(response, 404, { error: 'Nicht gefunden.' })
    }
    if (await auth.handle(request, response, path)) return
    const user = requireSession(request)
    if (request.method === 'GET' && path === '/api/home/activity') {
      const [live, temporary] = await Promise.all([streams.homeActivity(user.id), quickRooms.homeActivity()])
      requireSession(request)
      return json(response, 200, { ...live, activities: community.homeActivity(user.id),
        talkRooms: voice.homeActivity(user.id), watchParties: watchParties.homeActivity(user.id), quickRooms: temporary })
    }
    if (await quickRooms.handle(request, response, path)) return
    if (await appearance.handle(request, response, path, requireSession)) return
    if (await tutorials.handle(request, response, path)) return
    if (await presence.handle(request, response, path)) return
    if (await notifications.handle(request, response, url)) return
    if (await reactions.handle(request, response, url)) return
    if (await voice.handle(request, response, path)) return
    if (await watchParties.handle(request, response, url)) return
    if (await streamChat.handle(request, response, url)) return
    if (await streams.handle(request, response, path)) return
    if (await history.handle(request, response, url)) return
    if (await channelManagement.handle(request, response, url)) return
    if (await community.handle(request, response, url)) return
  }
  json(response, 404, { error: 'Nicht gefunden.' })
})

const privateApi = service(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/internal/media-auth') return response.writeHead(404).end()
  const auth = await readJson(request)
  if (voice.handleMedia(auth, response)) return
  if (!await streams.handleMedia(request, response, request.url, auth)) response.writeHead(404).end()
})

const apiPort = Number(process.env.PORT ?? 8080)
const mediaPort = Number(process.env.AUTH_PORT ?? 8081)
publicApi.listen(apiPort, host)
privateApi.listen(mediaPort, process.env.AUTH_HOST ?? host)

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  streams.close()
  community.close()
  presence.close()
  quickRooms.close()
  voice.close()
  watchParties.close()
  let servers = 2
  const closed = () => {
    if (--servers === 0) {
      desktopHandoff.close()
      db.close()
    }
  }
  publicApi.close(closed)
  privateApi.close(closed)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
