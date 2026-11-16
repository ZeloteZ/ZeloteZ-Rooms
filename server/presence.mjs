import { json, readJson, RequestError } from './http.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const leaseMs = 105_000
const maxRequestedUsers = 200
const maxTrackedUsers = 4096
const maxSessionsPerUser = 10

export function createPresence(db, { requireSession, sessionKey, isSessionActive, now = () => performance.now() }) {
  const leases = new Map()
  const visibleUsers = db.prepare(`SELECT requested.value AS id FROM json_each(:ids) requested
    WHERE requested.value = :viewer OR EXISTS (
      SELECT 1 FROM friendships f WHERE f.first_id = min(:viewer, requested.value)
        AND f.second_id = max(:viewer, requested.value) AND f.accepted = 1
    ) OR EXISTS (
      SELECT 1 FROM topic_members own JOIN topic_members peer
        ON peer.topic_id = own.topic_id AND peer.user_id = requested.value AND peer.joined_at IS NOT NULL
      WHERE own.user_id = :viewer AND own.joined_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.topic_id = own.topic_id)
    )`)

  function heartbeat(userId, key, time) {
    const sessions = leases.get(userId) ?? new Map()
    sessions.delete(key)
    sessions.set(key, time + leaseMs)
    if (sessions.size > maxSessionsPerUser) sessions.delete(sessions.keys().next().value)
    leases.delete(userId)
    leases.set(userId, sessions)
    if (leases.size > maxTrackedUsers) leases.delete(leases.keys().next().value)
  }

  function online(userId, time) {
    const sessions = leases.get(userId)
    if (!sessions) return false
    for (const [key, expiry] of sessions) {
      if (expiry > time && isSessionActive(key, userId)) return true
      sessions.delete(key)
    }
    leases.delete(userId)
    return false
  }

  const sweep = setInterval(() => {
    const time = now()
    for (const [userId, sessions] of leases) {
      for (const [key, expiry] of sessions) {
        if (expiry <= time) sessions.delete(key)
      }
      if (!sessions.size) leases.delete(userId)
    }
  }, leaseMs)
  sweep.unref()

  async function handle(request, response, path) {
    if (path !== '/api/presence') return false
    const user = requireSession(request)
    if (request.method !== 'POST') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    const { userIds, ...extra } = await readJson(request)
    if (Object.keys(extra).length || !Array.isArray(userIds) || userIds.length > maxRequestedUsers ||
        userIds.some(id => typeof id !== 'string' || !uuid.test(id))) {
      throw new RequestError(400, 'Ungültige Anwesenheitsabfrage.')
    }

    if (requireSession(request).id !== user.id) throw new RequestError(409, 'Das angemeldete Konto hat sich geändert.')
    const key = sessionKey(request)
    if (!key) throw new RequestError(401, 'Bitte melde dich an.')
    const time = now()
    heartbeat(user.id, key, time)
    const ids = JSON.stringify([...new Set(userIds)])
    json(response, 200, {
      online: visibleUsers.all({ viewer: user.id, ids }).map(row => row.id).filter(id => online(id, time)),
    })
    return true
  }

  return { handle, close: () => clearInterval(sweep) }
}
