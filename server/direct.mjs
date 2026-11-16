import { randomUUID } from 'node:crypto'
import { RequestError, transaction } from './http.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const conversationLimit = 200
const missing = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const friendsOnly = () => new RequestError(403, 'Direktnachrichten sind bestätigten Freunden vorbehalten.')

export function createDirect(db, profileFor) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_conversations (
      id TEXT PRIMARY KEY,
      first_id TEXT NOT NULL REFERENCES users(id),
      second_id TEXT NOT NULL REFERENCES users(id),
      topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
      channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
      created_at TEXT NOT NULL,
      first_read_seq INTEGER NOT NULL DEFAULT 0,
      second_read_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE (first_id, second_id),
      CHECK (first_id < second_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS direct_conversations_second ON direct_conversations(second_id);
  `)

  const conversations = `SELECT d.id, c.id AS channel_id, c.title, c.type, c.stream_policy, peer.id AS peer_id,
    peer.username, peer.display_name, (f.accepted IS 1 AND disabled.user_id IS NULL) AS can_send,
    coalesce((SELECT m.created_at FROM messages m WHERE m.channel_id = d.channel_id ORDER BY m.seq DESC LIMIT 1),
      d.created_at) AS updated_at,
    (SELECT count(*) FROM messages m WHERE m.channel_id = d.channel_id AND m.user_id = peer.id
      AND m.seq > CASE WHEN d.first_id = peer.id THEN d.second_read_seq ELSE d.first_read_seq END
      AND NOT EXISTS (SELECT 1 FROM message_deletions WHERE message_id = m.id)) AS unread_count
    FROM direct_conversations d JOIN channels c ON c.id = d.channel_id
    JOIN users peer ON peer.id = CASE WHEN d.first_id = :viewer THEN d.second_id ELSE d.first_id END
    LEFT JOIN friendships f ON f.first_id = d.first_id AND f.second_id = d.second_id
    LEFT JOIN disabled_accounts disabled ON disabled.user_id = peer.id
    WHERE (:viewer = d.first_id OR :viewer = d.second_id)`
  const find = db.prepare(`${conversations} AND d.id = :id`)
  const list = db.prepare(`${conversations} ORDER BY updated_at DESC, d.id DESC`)
  const existing = db.prepare('SELECT id FROM direct_conversations WHERE first_id = ? AND second_id = ?')
  const activeFriend = db.prepare(`SELECT 1 FROM friendships f WHERE first_id = ? AND second_id = ? AND accepted = 1
    AND NOT EXISTS (SELECT 1 FROM disabled_accounts WHERE user_id IN (f.first_id, f.second_id))`)
  const count = db.prepare('SELECT count(*) AS total FROM direct_conversations WHERE first_id = ? OR second_id = ?')
  const createTopic = db.prepare(`INSERT INTO topics(id, owner_id, title, visibility, created_at, stream_policy)
    VALUES (?, ?, 'Direct messages', 'private', ?, 'disabled')`)
  const addMember = db.prepare(`INSERT INTO topic_members(topic_id, user_id, role, approved, joined_at)
    VALUES (?, ?, 'member', 1, ?)`)
  const addChannel = db.prepare(`INSERT INTO channels(id, topic_id, title, type, stream_policy)
    VALUES (?, ?, 'Direct messages', 'chat', 'all')`)
  const addConversation = db.prepare(`INSERT INTO direct_conversations(id, first_id, second_id, topic_id, channel_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
  const byChannel = db.prepare('SELECT id, first_id, second_id FROM direct_conversations WHERE channel_id = ?')
  const sequence = db.prepare(`SELECT 1 FROM messages m JOIN direct_conversations d ON d.channel_id = m.channel_id
    WHERE d.id = ? AND m.seq = ?`)
  const mark = db.prepare(`UPDATE direct_conversations SET
    first_read_seq = CASE WHEN first_id = :viewer THEN max(first_read_seq, :seq) ELSE first_read_seq END,
    second_read_seq = CASE WHEN second_id = :viewer THEN max(second_read_seq, :seq) ELSE second_read_seq END
    WHERE id = :id AND :viewer IN (first_id, second_id)`)

  function view(row) {
    return {
      id: row.id,
      channel: { id: row.channel_id, title: row.title, type: row.type, streamPolicy: row.stream_policy },
      peer: { id: row.peer_id, username: row.username, displayName: row.display_name, ...profileFor(row.peer_id) },
      canSend: Boolean(row.can_send), unreadCount: row.unread_count, updatedAt: row.updated_at,
    }
  }

  function get(userId, id) {
    if (!uuid.test(id)) throw missing()
    const row = find.get({ viewer: userId, id })
    if (!row) throw missing()
    return view(row)
  }

  function open(userId, targetId) {
    if (typeof targetId !== 'string' || !uuid.test(targetId) || targetId === userId) throw missing()
    const [first, second] = [userId, targetId].sort()
    const id = transaction(db, () => {
      if (!activeFriend.get(first, second)) throw friendsOnly()
      const conversation = existing.get(first, second)
      if (conversation) return conversation.id
      if ([first, second].some(user => count.get(user, user).total >= conversationLimit)) {
        throw new RequestError(409, 'Die maximale Anzahl von Direktchats ist erreicht.')
      }
      const conversationId = randomUUID()
      const topicId = randomUUID()
      const channelId = randomUUID()
      const now = new Date().toISOString()
      createTopic.run(topicId, first, now)
      addMember.run(topicId, first, now)
      addMember.run(topicId, second, now)
      addChannel.run(channelId, topicId)
      addConversation.run(conversationId, first, second, topicId, channelId, now)
      return conversationId
    })
    return get(userId, id)
  }

  function assertCanSend(channelId, userId) {
    const conversation = byChannel.get(channelId)
    if (!conversation) return null
    if (userId !== conversation.first_id && userId !== conversation.second_id) throw missing()
    if (!activeFriend.get(conversation.first_id, conversation.second_id)) throw friendsOnly()
    return { id: conversation.id, peerId: userId === conversation.first_id ? conversation.second_id : conversation.first_id }
  }

  function read(userId, id, throughSeq, recordRead) {
    if (!uuid.test(id)) throw missing()
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 1) throw new RequestError(400, 'Ungültige Position im Chatverlauf.')
    transaction(db, () => {
      if (!sequence.get(id, throughSeq) || !mark.run({ viewer: userId, id, seq: throughSeq }).changes) throw missing()
      recordRead({ recipientId: userId, conversationId: id, throughSeq })
    })
  }

  return { get, open, list: userId => list.all({ viewer: userId }).map(view), read, assertCanSend }
}
