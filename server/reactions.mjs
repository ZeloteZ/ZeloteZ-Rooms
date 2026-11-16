import { json, readJson, RequestError, transaction } from './http.mjs'

const messageId = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const reactionId = '[A-Za-z0-9_-]{43}'
const resource = `(?:/(${messageId})/(${reactionId}))?$`
const chatPath = new RegExp(`^/api/channels/(${messageId})/messages/reactions${resource}`)
const streamPath = new RegExp(`^/api/streams/([a-f0-9]{32})/chat/reactions${resource}`)
const validMessageId = new RegExp(`^${messageId}$`)
const validNonce = /^[A-Za-z0-9_-]{16}$/u
const validBody = /^[A-Za-z0-9_-]{64}$/u
const maxBatchSize = 40
const maxOwnReactions = 12

const unavailable = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Reaktion.')

const originalAccess = `EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ?)`
const historyAccess = `EXISTS (SELECT 1 FROM message_history_grants WHERE message_id = m.id AND recipient_id = ?)`

function createStore(db, { reactions, messages, deletions, parent, sharedHistory }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${reactions} (
      message_id TEXT NOT NULL REFERENCES ${messages}(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL CHECK (length(id) = 43),
      nonce TEXT NOT NULL CHECK (length(nonce) = 16),
      body TEXT NOT NULL CHECK (length(body) = 64),
      PRIMARY KEY (message_id, user_id, id)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS remove_${reactions}_on_delete AFTER INSERT ON ${deletions}
    BEGIN
      DELETE FROM ${reactions} WHERE message_id = NEW.message_id;
    END;
  `)

  const visible = `m.${parent} = ? AND NOT EXISTS (SELECT 1 FROM ${deletions} WHERE message_id = m.id)
    AND (${sharedHistory ? `${originalAccess} OR ${historyAccess}` : originalAccess})`
  const readable = db.prepare(`SELECT 1 FROM ${messages} m WHERE m.id = ? AND ${visible}`)
  const read = db.prepare(`SELECT r.message_id AS messageId, r.user_id AS userId, u.display_name AS displayName,
    r.id, r.nonce, r.body FROM ${reactions} r JOIN ${messages} m ON m.id = r.message_id
    JOIN users u ON u.id = r.user_id WHERE m.id IN (SELECT value FROM json_each(?)) AND ${visible}
    ORDER BY r.message_id, r.user_id, r.id`)
  const upsert = db.prepare(`INSERT INTO ${reactions}(message_id, user_id, id, nonce, body) VALUES (?,?,?,?,?)
    ON CONFLICT(message_id, user_id, id) DO UPDATE SET nonce = excluded.nonce, body = excluded.body`)
  const remove = db.prepare(`DELETE FROM ${reactions} WHERE message_id = ? AND user_id = ? AND id = ?`)
  const count = db.prepare(`SELECT count(*) AS total FROM ${reactions} WHERE message_id = ? AND user_id = ?`)
  const viewers = userId => sharedHistory ? [userId, userId] : [userId]

  return {
    list(parentId, userId, ids) {
      return read.all(JSON.stringify(ids), parentId, ...viewers(userId))
    },
    change(parentId, userId, message, id, payload) {
      if (!readable.get(message, parentId, ...viewers(userId))) throw unavailable()
      if (!payload) return remove.run(message, userId, id)
      upsert.run(message, userId, id, payload.nonce, payload.body)
      if (count.get(message, userId).total > maxOwnReactions) {
        throw new RequestError(409, 'Du hast die maximale Anzahl an Reaktionen für diese Nachricht erreicht.')
      }
    },
  }
}

export function createReactions(db, { requireSession, streams }) {
  const text = createStore(db, {
    reactions: 'message_reactions', messages: 'messages', deletions: 'message_deletions',
    parent: 'channel_id', sharedHistory: true,
  })
  const stream = createStore(db, {
    reactions: 'stream_message_reactions', messages: 'stream_messages', deletions: 'stream_message_deletions',
    parent: 'stream_id', sharedHistory: false,
  })
  const chatMembership = db.prepare(`SELECT 1 FROM channels c JOIN topic_members m ON m.topic_id = c.topic_id
    WHERE c.id = ? AND c.type = 'chat' AND m.user_id = ? AND m.joined_at IS NOT NULL`)

  return {
    async handle(request, response, { pathname, searchParams }) {
      const chat = chatPath.exec(pathname)
      const match = chat ?? streamPath.exec(pathname)
      if (!match) return false
      const [, parentId, message, id] = match
      const store = chat ? text : stream
      const { method } = request

      function authorizedUser() {
        const { id: userId } = requireSession(request)
        if (chat) {
          if (!chatMembership.get(parentId, userId)) throw unavailable()
        } else streams.chatChannel(parentId, userId)
        return userId
      }

      const userId = authorizedUser()
      if (method === 'GET' && !message) {
        const raw = searchParams.get('ids')
        if (!raw || raw.length > maxBatchSize * 37 - 1) throw invalid()
        const ids = raw.split(',')
        if (ids.length > maxBatchSize || ids.some(id => !validMessageId.test(id))) throw invalid()
        json(response, 200, { reactions: store.list(parentId, userId, ids) })
      } else if (message && (method === 'PUT' || method === 'DELETE')) {
        const payload = method === 'PUT' ? await readJson(request, 512) : null
        if (payload && (Object.keys(payload).length !== 2 ||
          typeof payload.nonce !== 'string' || !validNonce.test(payload.nonce) ||
          typeof payload.body !== 'string' || !validBody.test(payload.body))) throw invalid()
        transaction(db, () => {
          if (authorizedUser() !== userId) throw unavailable()
          store.change(parentId, userId, message, id, payload)
        })
        response.writeHead(204).end()
      } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
      return true
    },
  }
}
