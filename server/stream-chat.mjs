import { validateEnvelope } from './community.mjs'
import { json, readJson, RequestError, transaction } from './http.mjs'

const audienceRoute = /^\/api\/streams\/([a-f0-9]{32})\/audience$/
const chatRoute = /^\/api\/streams\/([a-f0-9]{32})\/chat$/
const removalRoute = /^\/api\/streams\/([a-f0-9]{32})\/chat\/([a-f0-9-]{36})$/
const messageId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const pageSize = 40
const retentionCount = 250
const windowMs = 10000

export function createStreamChat(db, { requireSession, community, streams, profileFor, recordMentions = () => {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      stream_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      envelope TEXT NOT NULL CHECK (json_valid(envelope)),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS stream_messages_order ON stream_messages(stream_id, seq);
    CREATE TABLE IF NOT EXISTS stream_message_deletions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE REFERENCES stream_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      deleted_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS prune_ended_stream_chat AFTER UPDATE OF ended_at ON broadcasts
      WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL BEGIN
        DELETE FROM stream_messages WHERE stream_id = NEW.id;
      END;
  `)
  const select = `SELECT m.*, u.display_name, d.revision, d.user_id AS deleted_by,
    d.deleted_at, moderator.display_name AS moderator_name
    FROM stream_messages m JOIN users u ON u.id = m.user_id
    LEFT JOIN stream_message_deletions d ON d.message_id = m.id
    LEFT JOIN users moderator ON moderator.id = d.user_id`
  const ownMessage = db.prepare(`${select} WHERE m.id = ?`)
  const visible = `WHERE m.stream_id = ? AND (d.revision IS NOT NULL OR
    EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ?))`
  const recent = db.prepare(`${select} ${visible} ORDER BY m.seq DESC LIMIT ?`)
  const newer = db.prepare(`${select} ${visible} AND m.seq > ? ORDER BY m.seq LIMIT ?`)
  const deletions = db.prepare(`${select} WHERE m.stream_id = ? AND d.revision > ? ORDER BY d.revision`)
  const deletionVersion = db.prepare(`SELECT coalesce(max(d.revision), 0) AS version FROM stream_message_deletions d
    JOIN stream_messages m ON m.id = d.message_id WHERE m.stream_id = ?`)
  const redact = db.prepare('UPDATE stream_messages SET envelope = ? WHERE id = ?')
  const addDeletion = db.prepare('INSERT INTO stream_message_deletions(message_id, user_id, deleted_at) VALUES (?,?,?)')
  const insert = db.prepare('INSERT INTO stream_messages(id, stream_id, user_id, envelope, created_at) VALUES (?,?,?,?,?)')
  const prune = db.prepare(`DELETE FROM stream_messages WHERE stream_id = ? AND seq < (
    SELECT seq FROM stream_messages WHERE stream_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`)
  const posting = new Map()

  function message(row, userId, canManage = false) {
    const envelope = JSON.parse(row.envelope)
    if (envelope?.keys) envelope.keys = { [userId]: envelope.keys[userId] }
    const entry = {
      id: row.id, seq: row.seq, at: row.created_at,
      author: { id: row.user_id, displayName: row.display_name, ...profileFor(row.user_id) },
    }
    if (row.deleted_by) {
      return { ...entry, deletion: {
        by: { id: row.deleted_by, displayName: row.moderator_name, ...profileFor(row.deleted_by) },
        at: row.deleted_at, reason: envelope,
      } }
    }
    return { ...entry, envelope, own: row.user_id === userId, canDelete: canManage || row.user_id === userId }
  }

  function cursor(params, name) {
    const value = params.get(name)
    if (value === null) return null
    if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new RequestError(400, 'Ungültige Position im Streamchat.')
    }
    return Number(value)
  }

  async function handle(request, response, { pathname, searchParams }) {
    const audience = audienceRoute.exec(pathname)
    const chat = chatRoute.exec(pathname)
    const removal = removalRoute.exec(pathname)
    if (!audience && !chat && !removal) return false
    const actor = requireSession(request)
    if (request.method === 'GET' && audience) {
      json(response, 200, { viewers: streams.viewersFor(audience[1], actor.id) })
    } else if (request.method === 'GET' && chat) {
      const streamId = chat[1]
      const channelId = streams.chatChannel(streamId, actor.id)
      const canManage = community.channelAccess(actor.id, channelId)?.canManage
      const after = cursor(searchParams, 'after')
      const sinceDeletion = cursor(searchParams, 'deletionsAfter')
      const rows = after === null ? recent.all(streamId, actor.id, pageSize).reverse()
        : newer.all(streamId, actor.id, after, pageSize + 1)
      json(response, 200, {
        messages: rows.slice(0, pageSize).map(row => message(row, actor.id, canManage)),
        deletions: sinceDeletion === null ? [] : deletions.all(streamId, sinceDeletion).map(row => message(row, actor.id)),
        deletionVersion: deletionVersion.get(streamId).version,
        more: rows.length > pageSize,
        recipients: community.chatKeys(channelId).map(({ id, public_key }) => ({ id, publicKey: JSON.parse(public_key) })),
      })
    } else if (request.method === 'POST' && chat) {
      const streamId = chat[1]
      streams.chatChannel(streamId, actor.id)
      const input = await readJson(request, 65536)
      if (typeof input.id !== 'string' || !messageId.test(input.id)) throw new RequestError(400, 'Ungültige Nachricht.')
      const result = transaction(db, () => {
        const user = requireSession(request)
        const channelId = streams.chatChannel(streamId, user.id)
        const existing = ownMessage.get(input.id)
        if (existing) {
          if (existing.stream_id !== streamId || existing.user_id !== user.id) throw new RequestError(409, 'Nachricht bereits verwendet.')
          return message(existing, user.id)
        }
        const time = Date.now()
        for (const [id, window] of posting) if (window.until <= time) posting.delete(id)
        const quota = posting.get(user.id) ?? { count: 0, until: time + windowMs }
        if (quota.count >= 12) throw new RequestError(429, 'Warte kurz, bevor du erneut schreibst.')
        quota.count += 1
        posting.set(user.id, quota)
        const envelope = validateEnvelope(input.envelope, community.chatKeys(channelId))
        insert.run(input.id, streamId, user.id, envelope, new Date(time).toISOString())
        recordMentions({ channelId, senderId: user.id, messageId: input.id, streamId, mentionedUserIds: input.mentionedUserIds })
        prune.run(streamId, streamId, retentionCount - 1)
        return message(ownMessage.get(input.id), user.id)
      })
      json(response, 201, { message: result })
    } else if (request.method === 'DELETE' && removal && messageId.test(removal[2])) {
      const [, streamId, id] = removal
      streams.chatChannel(streamId, actor.id)
      const input = await readJson(request, 24576)
      const result = transaction(db, () => {
        const user = requireSession(request)
        const channelId = streams.chatChannel(streamId, user.id)
        const existing = ownMessage.get(id)
        if (!existing || existing.stream_id !== streamId) throw new RequestError(404, 'Nachricht nicht gefunden.')
        const own = existing.user_id === user.id
        if (!own && !community.channelAccess(user.id, channelId)?.canManage) {
          throw new RequestError(403, 'Du darfst diese Nachricht nicht löschen.')
        }
        if (existing.deleted_by) return message(existing, user.id)
        if (!own && (typeof input.reason?.body !== 'string' || input.reason.body.length > 4200)) {
          throw new RequestError(400, 'Gib einen Grund für das Löschen an.')
        }
        const envelope = own ? 'null' : validateEnvelope(input.reason, community.chatKeys(channelId))
        redact.run(envelope, id)
        addDeletion.run(id, user.id, new Date().toISOString())
        return message(ownMessage.get(id), user.id)
      })
      json(response, 200, { message: result })
    } else throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    return true
  }
  return { handle }
}
