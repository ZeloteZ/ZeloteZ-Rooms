import { json, RequestError } from './http.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const streamIdPattern = /^[a-f0-9]{32}$/u
const notificationRoute = /^\/api\/notifications(?:\/([1-9]\d{0,15}))?$/u
const maxMentions = 12
const retention = 200
const pageSize = 50
const suggestionPageSize = 160

const unavailable = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Markierungen.')

export function createNotifications(db, { requireSession, streams, profileFor = () => ({}) }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mention_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      chat_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      stream_message_id TEXT REFERENCES stream_messages(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      read_at TEXT,
      CHECK ((chat_message_id IS NULL) <> (stream_message_id IS NULL)),
      CHECK (recipient_id <> sender_id),
      UNIQUE (recipient_id, chat_message_id),
      UNIQUE (recipient_id, stream_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS mention_notifications_inbox ON mention_notifications(recipient_id, id DESC);
    CREATE INDEX IF NOT EXISTS mention_notifications_channel ON mention_notifications(channel_id);
    CREATE INDEX IF NOT EXISTS mention_notifications_chat ON mention_notifications(chat_message_id);
    CREATE INDEX IF NOT EXISTS mention_notifications_stream ON mention_notifications(stream_message_id);
    CREATE TRIGGER IF NOT EXISTS remove_chat_mention_notifications AFTER INSERT ON message_deletions
      BEGIN
        DELETE FROM mention_notifications WHERE chat_message_id = NEW.message_id;
      END;
    CREATE TRIGGER IF NOT EXISTS remove_stream_mention_notifications AFTER INSERT ON stream_message_deletions
      BEGIN
        DELETE FROM mention_notifications WHERE stream_message_id = NEW.message_id;
      END;
  `)

  const sourceRoom = db.prepare(`SELECT c.topic_id, c.type FROM channels c JOIN topic_members tm
    ON tm.topic_id = c.topic_id AND tm.user_id = ? AND tm.joined_at IS NOT NULL WHERE c.id = ?`)
  const userSuggestions = db.prepare(`SELECT 'user' AS kind, u.id, u.display_name AS label, '@' || u.username AS detail
    FROM topic_members tm JOIN users u ON u.id = tm.user_id WHERE tm.topic_id = ? AND tm.joined_at IS NOT NULL AND u.id > ?
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = u.id) ORDER BY u.id LIMIT ?`)
  const roomSuggestions = db.prepare(`SELECT 'room' AS kind, t.id, t.title AS label FROM topics t
    LEFT JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = ?
    WHERE t.id > ? AND (t.visibility = 'public' OR tm.joined_at IS NOT NULL OR tm.approved = 1) ORDER BY t.id LIMIT ?`)
  const channelSuggestions = db.prepare(`SELECT 'channel' AS kind, c.id, c.title AS label,
    c.topic_id AS roomId, t.title AS detail
    FROM topic_members tm JOIN topics t ON t.id = tm.topic_id JOIN channels c ON c.topic_id = t.id
    WHERE tm.user_id = ? AND tm.joined_at IS NOT NULL AND c.id > ? ORDER BY c.id LIMIT ?`)
  const insert = db.prepare(`INSERT INTO mention_notifications
    (recipient_id, sender_id, channel_id, chat_message_id, stream_message_id, created_at)
    SELECT ?, ?, ?, ?, ?, ? FROM topic_members tm
    WHERE tm.topic_id = ? AND tm.user_id = ? AND tm.joined_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = tm.user_id)
    ON CONFLICT DO NOTHING`)
  const prune = db.prepare(`DELETE FROM mention_notifications WHERE recipient_id = ? AND id <= (
    SELECT id FROM mention_notifications WHERE recipient_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
  const inbox = db.prepare(`SELECT n.id, n.sender_id, n.created_at, n.read_at, c.id AS channel_id,
    c.title AS channel_title, t.id AS room_id, t.title AS room_title, u.display_name,
    coalesce(n.chat_message_id, n.stream_message_id) AS message_id,
    coalesce(m.seq, sm.seq) AS message_seq, sm.stream_id
    FROM mention_notifications n
    JOIN channels c ON c.id = n.channel_id
    JOIN topics t ON t.id = c.topic_id
    JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = n.recipient_id AND tm.joined_at IS NOT NULL
    JOIN users u ON u.id = n.sender_id
    LEFT JOIN messages m ON m.id = n.chat_message_id
    LEFT JOIN stream_messages sm ON sm.id = n.stream_message_id
    WHERE n.recipient_id = ? ORDER BY n.id DESC`)
  const markOne = db.prepare(`UPDATE mention_notifications SET read_at = ?
    WHERE recipient_id = ? AND id = ? AND read_at IS NULL`)
  const markAll = db.prepare(`UPDATE mention_notifications SET read_at = ?
    WHERE recipient_id = ? AND read_at IS NULL`)

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
      const result = insert.run(recipientId, senderId, channelId, streamId ? null : messageId,
        streamId ? messageId : null, createdAt, source.topic_id, recipientId)
      if (result.changes) prune.run(recipientId, recipientId, retention)
    }
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
        try {
          streamAccess.set(row.stream_id, streams.chatChannel(row.stream_id, userId))
        } catch (error) {
          if (!(error instanceof RequestError) || error.status !== 404) throw error
          streamAccess.set(row.stream_id, null)
        }
      }
      return streamAccess.get(row.stream_id) === row.channel_id
    })
  }

  function notification(row) {
    return {
      id: row.id, kind: 'mention', source: row.stream_id ? 'stream' : 'chat',
      actor: { id: row.sender_id, displayName: row.display_name, ...profileFor(row.sender_id) },
      roomId: row.room_id, roomTitle: row.room_title, channelId: row.channel_id, channelTitle: row.channel_title,
      messageId: row.message_id, messageSeq: row.message_seq, createdAt: row.created_at, readAt: row.read_at,
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
  return { handle, recordMentions }
}
