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
const maxTrackedActors = 4096

const unavailable = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Reaktion.')

const originalAccess = `EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ?)`
const historyAccess = `EXISTS (SELECT 1 FROM message_history_grants WHERE message_id = m.id AND recipient_id = ?)`

function initializeStorage(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS reaction_storage (
      scope TEXT PRIMARY KEY, reactions INTEGER NOT NULL CHECK (reactions >= 0)
    ) STRICT, WITHOUT ROWID`)
    if (!db.prepare("SELECT 1 FROM reaction_storage WHERE scope = ''").get()) {
      db.exec(`
        DELETE FROM reaction_storage;
        INSERT INTO reaction_storage SELECT '',
          (SELECT count(*) FROM message_reactions) + (SELECT count(*) FROM stream_message_reactions);
        INSERT INTO reaction_storage SELECT user_id, count(*) FROM (
          SELECT user_id FROM message_reactions UNION ALL SELECT user_id FROM stream_message_reactions
        ) GROUP BY user_id;
      `)
    }
    for (const table of ['message_reactions', 'stream_message_reactions']) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS count_${table}_insert AFTER INSERT ON ${table} BEGIN
          UPDATE reaction_storage SET reactions = reactions + 1 WHERE scope = '';
          INSERT INTO reaction_storage VALUES (NEW.user_id, 1)
            ON CONFLICT(scope) DO UPDATE SET reactions = reactions + 1;
        END;
        CREATE TRIGGER IF NOT EXISTS count_${table}_delete AFTER DELETE ON ${table} BEGIN
          UPDATE reaction_storage SET reactions = reactions - 1 WHERE scope IN ('', OLD.user_id);
          DELETE FROM reaction_storage WHERE scope = OLD.user_id AND reactions = 0;
        END;
      `)
    }
  })
}

function createStore(db, { reactions, messages, deletions, parent, sharedHistory, checkStorage }) {
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
  const existing = db.prepare(`SELECT 1 FROM ${reactions} WHERE message_id = ? AND user_id = ? AND id = ?`)
  const viewers = userId => sharedHistory ? [userId, userId] : [userId]

  return {
    list(parentId, userId, ids) {
      return read.all(JSON.stringify(ids), parentId, ...viewers(userId))
    },
    change(parentId, userId, message, id, payload) {
      if (!readable.get(message, parentId, ...viewers(userId))) throw unavailable()
      if (!payload) return remove.run(message, userId, id)
      if (!existing.get(message, userId, id)) {
        if (count.get(message, userId).total >= maxOwnReactions) {
          throw new RequestError(409, 'Du hast die maximale Anzahl an Reaktionen für diese Nachricht erreicht.')
        }
        checkStorage(userId)
      }
      upsert.run(message, userId, id, payload.nonce, payload.body)
    },
  }
}

export function createReactions(db, { requireSession, streams, assertChatWritable = () => {} }, {
  maxTotal = 200_000, maxPerUser = 20_000, maxMutations = 30, windowMs = 10_000, now = () => performance.now(),
} = {}) {
  // Reaction fields have fixed, validated widths. A row budget bounds their stored payload.
  const checkStorage = userId => {
    if (usage.get('').reactions >= maxTotal || (usage.get(userId)?.reactions ?? 0) >= maxPerUser) {
      throw new RequestError(413, 'Der Speicher für Chatnachrichten ist voll.')
    }
  }
  const text = createStore(db, {
    reactions: 'message_reactions', messages: 'messages', deletions: 'message_deletions',
    parent: 'channel_id', sharedHistory: true, checkStorage,
  })
  const stream = createStore(db, {
    reactions: 'stream_message_reactions', messages: 'stream_messages', deletions: 'stream_message_deletions',
    parent: 'stream_id', sharedHistory: false, checkStorage,
  })
  initializeStorage(db)
  const usage = db.prepare('SELECT reactions FROM reaction_storage WHERE scope = ?')
  const mutations = new Map()
  function chargeMutation(userId, response) {
    const at = now()
    for (const [id, entry] of mutations) if (entry.until <= at) mutations.delete(id)
    let entry = mutations.get(userId)
    if (!entry) {
      if (mutations.size >= maxTrackedActors) mutations.delete(mutations.keys().next().value)
      entry = { count: 0, until: at + windowMs }
      mutations.set(userId, entry)
    }
    if (entry.count >= maxMutations) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - at) / 1000))))
      throw new RequestError(429, 'Zu viele Versuche. Warte bitte einen Moment.')
    }
    entry.count++
  }
  const chatMembership = db.prepare(`SELECT 1 FROM channels c JOIN topic_members m ON m.topic_id = c.topic_id
    LEFT JOIN direct_conversations d ON d.topic_id = c.topic_id
    WHERE c.id = ? AND m.user_id = ? AND m.joined_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM quick_rooms q WHERE q.topic_id = c.topic_id)
    AND (d.id IS NULL OR (c.id = d.channel_id AND m.user_id IN (d.first_id, d.second_id)))`)

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
          if (chat && method === 'PUT') assertChatWritable(parentId, userId)
          chargeMutation(userId, response)
          store.change(parentId, userId, message, id, payload)
        })
        response.writeHead(204).end()
      } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
      return true
    },
  }
}
