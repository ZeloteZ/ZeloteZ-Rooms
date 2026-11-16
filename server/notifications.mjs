import { json, RequestError, transaction } from './http.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const streamIdPattern = /^[a-f0-9]{32}$/u
const notificationRoute = /^\/api\/notifications(?:\/([1-9]\d{0,15}))?$/u
const maxMentions = 12
const retention = 200
const pageSize = 50
const suggestionPageSize = 160

const unavailable = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Markierungen.')

export function createNotifications(db, { requireSession, streams, profileFor = () => ({}), notifyLive = () => false }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
      chat_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      stream_message_id TEXT REFERENCES stream_messages(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES direct_conversations(id) ON DELETE CASCADE,
      broadcast_id TEXT REFERENCES broadcasts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      read_at TEXT,
      CHECK (CASE kind
        WHEN 'mention' THEN channel_id IS NOT NULL AND (chat_message_id IS NULL) <> (stream_message_id IS NULL)
          AND conversation_id IS NULL AND broadcast_id IS NULL
        WHEN 'friend-request' THEN channel_id IS NULL AND chat_message_id IS NULL AND stream_message_id IS NULL
          AND conversation_id IS NULL AND broadcast_id IS NULL
        WHEN 'direct-message' THEN channel_id IS NOT NULL AND chat_message_id IS NOT NULL AND stream_message_id IS NULL
          AND conversation_id IS NOT NULL AND broadcast_id IS NULL
        WHEN 'live' THEN channel_id IS NOT NULL AND chat_message_id IS NULL AND stream_message_id IS NULL
          AND conversation_id IS NULL AND broadcast_id IS NOT NULL
        ELSE 0
      END),
      CHECK (recipient_id <> sender_id),
      UNIQUE (recipient_id, chat_message_id),
      UNIQUE (recipient_id, stream_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inbox_notifications_recipient ON inbox_notifications(recipient_id, id DESC);
    CREATE INDEX IF NOT EXISTS inbox_notifications_channel ON inbox_notifications(channel_id);
    CREATE INDEX IF NOT EXISTS inbox_notifications_chat ON inbox_notifications(chat_message_id);
    CREATE INDEX IF NOT EXISTS inbox_notifications_stream ON inbox_notifications(stream_message_id);
    CREATE INDEX IF NOT EXISTS inbox_notifications_broadcast ON inbox_notifications(broadcast_id);
    CREATE TRIGGER IF NOT EXISTS remove_chat_notifications AFTER INSERT ON message_deletions
      BEGIN
        DELETE FROM inbox_notifications WHERE chat_message_id = NEW.message_id;
      END;
    CREATE TRIGGER IF NOT EXISTS remove_stream_notifications AFTER INSERT ON stream_message_deletions
      BEGIN
        DELETE FROM inbox_notifications WHERE stream_message_id = NEW.message_id;
      END;
    CREATE TRIGGER IF NOT EXISTS remove_accepted_friend_notification AFTER UPDATE OF accepted ON friendships
      WHEN NEW.accepted = 1
      BEGIN
        DELETE FROM inbox_notifications WHERE kind = 'friend-request' AND sender_id = NEW.requester_id
          AND recipient_id = CASE WHEN NEW.requester_id = NEW.first_id THEN NEW.second_id ELSE NEW.first_id END;
      END;
    CREATE TRIGGER IF NOT EXISTS remove_cancelled_friend_notification AFTER DELETE ON friendships
      BEGIN
        DELETE FROM inbox_notifications WHERE kind = 'friend-request' AND sender_id = OLD.requester_id
          AND recipient_id = CASE WHEN OLD.requester_id = OLD.first_id THEN OLD.second_id ELSE OLD.first_id END;
      END;
    CREATE TABLE IF NOT EXISTS live_notification_deliveries (
      broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (broadcast_id, recipient_id)
    ) STRICT, WITHOUT ROWID;
  `)
  transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mention_notifications'").get()) return
    const current = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'inbox_notifications'").get()
    const past = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'mention_notifications'").get()
    const legacyId = current ? '' : 'id, '
    db.exec(`
      INSERT OR IGNORE INTO inbox_notifications(${legacyId}recipient_id, sender_id, kind, channel_id, chat_message_id,
        stream_message_id, created_at, read_at)
        SELECT ${legacyId}recipient_id, sender_id, 'mention', channel_id, chat_message_id, stream_message_id, created_at, read_at
          FROM mention_notifications ORDER BY id;
      DROP TRIGGER IF EXISTS remove_chat_mention_notifications;
      DROP TRIGGER IF EXISTS remove_stream_mention_notifications;
      DROP TABLE mention_notifications;
    `)
    if (!current && past) {
      const updated = db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'inbox_notifications'").run(past.seq)
      if (!updated.changes) db.prepare("INSERT INTO sqlite_sequence VALUES ('inbox_notifications', ?)").run(past.seq)
    }
  })

  const sourceRoom = db.prepare(`SELECT c.topic_id, c.type FROM channels c JOIN topic_members tm
    ON tm.topic_id = c.topic_id AND tm.user_id = ? AND tm.joined_at IS NOT NULL
    LEFT JOIN direct_conversations d ON d.topic_id = c.topic_id
    WHERE c.id = ? AND (d.id IS NULL OR (c.id = d.channel_id AND tm.user_id IN (d.first_id, d.second_id)))`)
  const userSuggestions = db.prepare(`SELECT 'user' AS kind, u.id, u.display_name AS label, '@' || u.username AS detail
    FROM topic_members tm JOIN users u ON u.id = tm.user_id
    LEFT JOIN direct_conversations d ON d.topic_id = tm.topic_id
    WHERE tm.topic_id = ? AND tm.joined_at IS NOT NULL AND u.id > ? AND (d.id IS NULL OR u.id IN (d.first_id, d.second_id))
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id) ORDER BY u.id LIMIT ?`)
  const roomSuggestions = db.prepare(`SELECT 'room' AS kind, t.id, t.title AS label FROM topics t
    LEFT JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = ?
    WHERE t.id > ? AND (t.visibility = 'public' OR tm.joined_at IS NOT NULL OR tm.approved = 1)
    AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.topic_id = t.id) ORDER BY t.id LIMIT ?`)
  const channelSuggestions = db.prepare(`SELECT 'channel' AS kind, c.id, c.title AS label,
    c.topic_id AS roomId, t.title AS detail
    FROM topic_members tm JOIN topics t ON t.id = tm.topic_id JOIN channels c ON c.topic_id = t.id
    WHERE tm.user_id = ? AND tm.joined_at IS NOT NULL AND c.id > ?
    AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.channel_id = c.id) ORDER BY c.id LIMIT ?`)
  const insertMention = db.prepare(`INSERT INTO inbox_notifications
    (recipient_id, sender_id, kind, channel_id, chat_message_id, stream_message_id, created_at)
    SELECT ?, ?, 'mention', ?, ?, ?, ? FROM topic_members tm
    WHERE tm.topic_id = ? AND tm.user_id = ? AND tm.joined_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = tm.user_id)
    ON CONFLICT DO NOTHING`)
  const insertFriendRequest = db.prepare(`INSERT INTO inbox_notifications(recipient_id, sender_id, kind, created_at)
    VALUES (?, ?, 'friend-request', ?)`)
  const insertDirect = db.prepare(`INSERT INTO inbox_notifications(recipient_id, sender_id, kind, channel_id,
    chat_message_id, conversation_id, created_at) VALUES (?, ?, 'direct-message', ?, ?, ?, ?)`)
  const liveAudience = db.prepare(`SELECT tm.user_id FROM broadcasts b JOIN channels c ON c.id = b.channel_id
    JOIN topic_members tm ON tm.topic_id = c.topic_id AND tm.joined_at IS NOT NULL
    WHERE b.id = ? AND b.channel_id = ? AND b.user_id = ? AND b.ended_at IS NULL AND b.publisher_id IS NOT NULL
    AND tm.user_id <> b.user_id AND c.type = 'live'
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts WHERE user_id = tm.user_id)
    AND NOT EXISTS (SELECT 1 FROM live_notification_deliveries d WHERE d.broadcast_id = b.id AND d.recipient_id = tm.user_id)`)
  const rememberLive = db.prepare('INSERT OR IGNORE INTO live_notification_deliveries VALUES (?, ?)')
  const insertLive = db.prepare(`INSERT INTO inbox_notifications(recipient_id, sender_id, kind, channel_id,
    broadcast_id, created_at) VALUES (?, ?, 'live', ?, ?, ?)`)
  const prune = db.prepare(`DELETE FROM inbox_notifications WHERE recipient_id = ? AND id <= (
    SELECT id FROM inbox_notifications WHERE recipient_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
  const inbox = db.prepare(`SELECT n.id, n.sender_id, n.kind, n.created_at, n.read_at, n.conversation_id, n.broadcast_id, c.id AS channel_id,
    c.title AS channel_title, t.id AS room_id, t.title AS room_title, u.display_name,
    coalesce(n.chat_message_id, n.stream_message_id) AS message_id,
    coalesce(m.seq, sm.seq) AS message_seq, sm.stream_id
    FROM inbox_notifications n
    LEFT JOIN channels c ON c.id = n.channel_id
    LEFT JOIN topics t ON t.id = c.topic_id
    LEFT JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = n.recipient_id AND tm.joined_at IS NOT NULL
    JOIN users u ON u.id = n.sender_id
    LEFT JOIN messages m ON m.id = n.chat_message_id
    LEFT JOIN stream_messages sm ON sm.id = n.stream_message_id
    WHERE n.recipient_id = ? AND (tm.user_id IS NOT NULL OR (n.kind = 'friend-request'
      AND NOT EXISTS (SELECT 1 FROM disabled_accounts WHERE user_id = n.sender_id))) ORDER BY n.id DESC`)
  const markOne = db.prepare(`UPDATE inbox_notifications SET read_at = ?
    WHERE recipient_id = ? AND id = ? AND read_at IS NULL`)
  const markAll = db.prepare(`UPDATE inbox_notifications SET read_at = ?
    WHERE recipient_id = ? AND read_at IS NULL`)
  const markDirect = db.prepare(`UPDATE inbox_notifications AS n SET read_at = ?
    WHERE recipient_id = ? AND conversation_id = ? AND read_at IS NULL
    AND (SELECT seq FROM messages WHERE id = n.chat_message_id) <= ?`)
  const moveMention = db.prepare("UPDATE inbox_notifications SET channel_id = ? WHERE kind = 'mention' AND chat_message_id = ?")

  // Both message handlers call this in the same transaction as their new message.
  function recordMentions({ channelId, senderId, messageId, streamId, mentionedUserIds }) {
    if (mentionedUserIds === undefined) return
    if (!Array.isArray(mentionedUserIds) || mentionedUserIds.length > maxMentions ||
        mentionedUserIds.some(id => typeof id !== 'string' || !uuid.test(id))) throw invalid()
    if (!mentionedUserIds.length) return

    const source = sourceRoom.get(senderId, channelId)
    if (!source || source.type !== (streamId ? 'live' : 'chat')) throw unavailable()
    const createdAt = new Date().toISOString()
    for (const recipientId of new Set(mentionedUserIds)) {
      if (recipientId === senderId) continue
      const result = insertMention.run(recipientId, senderId, channelId, streamId ? null : messageId,
        streamId ? messageId : null, createdAt, source.topic_id, recipientId)
      if (result.changes) prune.run(recipientId, recipientId, retention)
    }
  }

  function recordFriendRequest({ recipientId, senderId }) {
    insertFriendRequest.run(recipientId, senderId, new Date().toISOString())
    prune.run(recipientId, recipientId, retention)
  }

  function recordDirectMessage({ recipientId, senderId, channelId, messageId, conversationId }) {
    insertDirect.run(recipientId, senderId, channelId, messageId, conversationId, new Date().toISOString())
    prune.run(recipientId, recipientId, retention)
  }

  function recordDirectRead({ recipientId, conversationId, throughSeq }) {
    markDirect.run(new Date().toISOString(), recipientId, conversationId, throughSeq)
  }

  function visibleStreamChannel(streamId, userId) {
    try {
      return streams.chatChannel(streamId, userId)
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error
      return null
    }
  }

  function recordLive({ channelId, streamId, senderId }) {
    const audience = liveAudience.all(streamId, channelId, senderId)
      .filter(({ user_id }) => notifyLive(user_id) && visibleStreamChannel(streamId, user_id) === channelId)
    if (!audience.length) return
    const at = new Date().toISOString()
    transaction(db, () => {
      for (const { user_id: userId } of audience) {
        if (!rememberLive.run(streamId, userId).changes) continue
        insertLive.run(userId, senderId, channelId, streamId, at)
        prune.run(userId, userId, retention)
      }
    })
  }

  function suggestions(userId, params) {
    const chat = params.get('channelId')
    const stream = params.get('streamId')
    if ((chat === null) === (stream === null) ||
        (chat !== null && !uuid.test(chat)) || (stream !== null && !streamIdPattern.test(stream))) throw invalid()
    const channelId = stream === null ? chat : streams.chatChannel(stream, userId)
    const room = sourceRoom.get(userId, channelId)
    if (!room || room.type !== (stream === null ? 'chat' : 'live')) throw unavailable()
    const steps = [
      ['user', userSuggestions, room.topic_id],
      ['room', roomSuggestions, userId],
      ['channel', channelSuggestions, userId],
    ]
    const cursor = params.get('after')
    let offset = 0
    let start = ''
    if (cursor !== null) {
      const [kind, value, extra] = cursor.split(':')
      offset = steps.findIndex(([supported]) => supported === kind)
      if (offset < 0 || !value || !uuid.test(value) || extra !== undefined) throw invalid()
      start = value
    }
    const result = []
    for (const [, select, key] of steps.slice(offset)) {
      result.push(...select.all(key, start, suggestionPageSize + 1 - result.length))
      if (result.length > suggestionPageSize) break
      start = ''
    }
    const page = result.slice(0, suggestionPageSize)
    const last = page.at(-1)
    return { suggestions: page, next: result.length > suggestionPageSize ? `${last.kind}:${last.id}` : null }
  }

  function visibleInbox(userId) {
    const streamAccess = new Map()
    return inbox.all(userId).filter(row => {
      if (!row.stream_id) return true
      if (!streamAccess.has(row.stream_id)) {
        streamAccess.set(row.stream_id, visibleStreamChannel(row.stream_id, userId))
      }
      return streamAccess.get(row.stream_id) === row.channel_id
    })
  }

  function notification(row) {
    const common = {
      id: row.id, kind: row.kind,
      actor: { id: row.sender_id, displayName: row.display_name, ...profileFor(row.sender_id) },
      createdAt: row.created_at, readAt: row.read_at,
    }
    if (row.kind === 'friend-request') return common
    if (row.kind === 'direct-message') return {
      ...common, conversationId: row.conversation_id, channelId: row.channel_id,
      messageId: row.message_id, messageSeq: row.message_seq,
    }
    const room = { roomId: row.room_id, roomTitle: row.room_title, channelId: row.channel_id, channelTitle: row.channel_title }
    if (row.kind === 'live') return { ...common, ...room, streamId: row.broadcast_id }
    return {
      ...common, ...room, source: row.stream_id ? 'stream' : 'chat',
      messageId: row.message_id, messageSeq: row.message_seq,
      ...(row.stream_id ? { streamId: row.stream_id } : {}),
    }
  }

  function handle(request, response, { pathname, searchParams }) {
    const mentionPath = pathname === '/api/mentions'
    const match = notificationRoute.exec(pathname)
    if (!mentionPath && !match) return false
    const user = requireSession(request)
    if (mentionPath && request.method === 'GET') {
      json(response, 200, suggestions(user.id, searchParams))
    } else if (match && !match[1] && request.method === 'GET') {
      const rows = visibleInbox(user.id)
      const unreadCount = rows.reduce((count, row) => count + Number(row.read_at === null), 0)
      json(response, 200, { notifications: rows.slice(0, pageSize).map(notification), unreadCount })
    } else if (match && request.method === 'PATCH') {
      const at = new Date().toISOString()
      if (match[1]) {
        const id = Number(match[1])
        if (!Number.isSafeInteger(id)) throw unavailable()
        markOne.run(at, user.id, id)
      } else markAll.run(at, user.id)
      response.writeHead(204).end()
    } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    return true
  }
  return { handle, recordMentions, recordFriendRequest, recordDirectMessage, recordDirectRead, recordLive,
    updateMovedMention: ({ channelId, messageId }) => moveMention.run(channelId, messageId) }
}
