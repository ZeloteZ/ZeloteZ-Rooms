import { randomUUID } from 'node:crypto'
import { channelList, initializeChannelOrder } from './channel-management.mjs'
import { json, readBytes, readJson, RequestError, transaction } from './http.mjs'
import { responseLocale } from './locale.mjs'

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const invisibleControls = /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u
const fileLimit = 12 * 1024 * 1024 + 28
const totalFileLimit = 2 * 1024 * 1024 * 1024
const userFileLimit = 250 * 1024 * 1024
const stagingTime = 60 * 60 * 1000
const maxMembers = 80

const missing = () => new RequestError(404, 'Dieser Bereich ist nicht verfügbar.')
const forbidden = () => new RequestError(403, 'Dafür fehlt dir die Berechtigung.')
const joinHistory = 'LEFT JOIN message_history_grants g ON g.message_id = m.id AND g.recipient_id = ?'
const originalAccess = `EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ?)`
const historyFields = 'g.wrapper AS history_wrapper, g.grantor_id AS history_grantor'
const joinDeletion = 'LEFT JOIN message_deletions d ON d.message_id = m.id LEFT JOIN users moderator ON moderator.id = d.user_id'
const deletionFields = 'd.deleted_at, d.user_id AS deleted_by, moderator.display_name AS deleted_by_name'
const undeleted = 'NOT EXISTS (SELECT 1 FROM message_deletions WHERE message_id = m.id)'

function name(value, max) {
  const clean = typeof value === 'string' ? value.trim().normalize('NFC') : ''
  if (!clean || [...clean].length > max || invisibleControls.test(clean)) {
    throw new RequestError(400, `Gib einen Namen mit höchstens ${max} Zeichen ein.`)
  }
  return clean
}

function select(value, options) {
  if (!options.includes(value)) throw new RequestError(400, 'Ungültige Auswahl.')
  return value
}

function assertId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw missing()
}

function topicView(row, appearance) {
  return {
    id: row.id, title: row.title, visibility: row.visibility, ownerId: row.owner_id, streamPolicy: row.stream_policy,
    role: row.joined_at ? row.role : null, joined: Boolean(row.joined_at),
    invited: row.approved === 1 && !row.joined_at, favorite: row.favorite === 1,
    visitedAt: row.visited_at ?? null, createdAt: row.created_at,
    canDesign: Boolean(row.joined_at && (row.role === 'owner' || row.design_grant)),
    appearance: appearance.topic(row.id, Boolean(row.joined_at)),
  }
}

function messageView(row, profileFor) {
  const envelope = JSON.parse(row.envelope)
  const author = { id: row.user_id, displayName: row.display_name, ...profileFor(row.user_id) }
  if (envelope && row.history_wrapper) {
    envelope.keys = {}
    envelope.historyGrant = { ...JSON.parse(row.history_wrapper), grantorId: row.history_grantor }
  }
  if (row.deleted_at) {
    return {
      id: row.id, seq: row.seq, author, at: row.created_at,
      deleted: { at: row.deleted_at, by: { id: row.deleted_by, displayName: row.deleted_by_name, ...profileFor(row.deleted_by) }, reason: envelope },
    }
  }
  return {
    id: row.id, seq: row.seq, author,
    at: row.created_at, envelope,
  }
}

function encoded(value, min, max = min) {
  return typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/u.test(value)
}

export function validateEnvelope(value, recipients) {
  const invalid = () => new RequestError(400, 'Ungültige verschlüsselte Nachricht.')
  if (value?.v !== 1 || !encoded(value.nonce, 16) || !encoded(value.body, 22, 27000) ||
      value.ephemeral?.kty !== 'EC' || value.ephemeral.crv !== 'P-256' ||
      !encoded(value.ephemeral.x, 43) || !encoded(value.ephemeral.y, 43) ||
      !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw invalid()
  if (Object.keys(value.keys).length !== recipients.length || recipients.some(({ id }) => !Object.hasOwn(value.keys, id))) {
    throw new RequestError(409, 'Die Mitgliederliste hat sich geändert. Bitte sende erneut.')
  }
  const keys = Object.fromEntries(recipients.map(({ id }) => {
    const box = value.keys[id]
    if (!encoded(box?.nonce, 16) || !encoded(box.blob, 64)) throw invalid()
    return [id, { nonce: box.nonce, blob: box.blob }]
  }))
  return JSON.stringify({
    v: 1, ephemeral: { kty: 'EC', crv: 'P-256', x: value.ephemeral.x, y: value.ephemeral.y },
    nonce: value.nonce, body: value.body, keys,
  })
}

export function createCommunity(db, { requireSession, appearance, recordMentions = () => {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      first_id TEXT NOT NULL REFERENCES users(id), second_id TEXT NOT NULL REFERENCES users(id),
      requester_id TEXT NOT NULL REFERENCES users(id), accepted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(first_id, second_id), CHECK (first_id < second_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')), created_at TEXT NOT NULL,
      stream_policy TEXT NOT NULL DEFAULT 'all' CHECK (stream_policy IN ('all', 'admins', 'disabled'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topic_members (
      topic_id TEXT NOT NULL REFERENCES topics(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')), approved INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT, visited_at TEXT, favorite INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(topic_id, user_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS member_topics ON topic_members(user_id, topic_id);
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), title TEXT NOT NULL COLLATE NOCASE,
      type TEXT NOT NULL CHECK (type IN ('chat', 'live')),
      stream_policy TEXT NOT NULL CHECK (stream_policy IN ('all', 'admins')), UNIQUE(topic_id, title)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL REFERENCES channels(id),
      user_id TEXT NOT NULL REFERENCES users(id), envelope TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS channel_messages ON messages(channel_id, seq);
    CREATE TABLE IF NOT EXISTS message_deletions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      deleted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS channel_message_deletions ON message_deletions(channel_id, revision);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id),
      user_id TEXT NOT NULL REFERENCES users(id), message_id TEXT REFERENCES messages(id),
      bytes BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pending_attachments ON attachments(message_id, created_at);
    CREATE INDEX IF NOT EXISTS user_uploads ON attachments(user_id);
  `)
  initializeChannelOrder(db)

  const topicSelect = `SELECT t.*, m.role, m.approved, m.joined_at, m.visited_at, m.favorite,
    EXISTS (SELECT 1 FROM topic_designers d WHERE d.topic_id = t.id AND d.user_id = m.user_id) AS design_grant
    FROM topics t LEFT JOIN topic_members m ON m.topic_id = t.id AND m.user_id = ?`
  const topicById = db.prepare(`${topicSelect} WHERE t.id = ? AND (t.visibility = 'public' OR m.user_id IS NOT NULL)`)
  const listTopics = db.prepare(`${topicSelect} WHERE t.visibility = 'public' OR m.user_id IS NOT NULL ORDER BY t.created_at DESC`)
  const findChannel = db.prepare(`SELECT c.*, m.role, t.stream_policy AS topic_stream_policy FROM channels c
    JOIN topics t ON t.id = c.topic_id
    JOIN topic_members m ON m.topic_id = c.topic_id AND m.user_id = ? AND m.joined_at IS NOT NULL WHERE c.id = ?`)
  const recipientKeys = db.prepare(`SELECT u.id, u.public_key FROM topic_members m JOIN users u ON u.id = m.user_id
    WHERE m.topic_id = ? AND m.joined_at IS NOT NULL ORDER BY u.id`)
  const channelTopic = db.prepare('SELECT topic_id FROM channels WHERE id = ?')
  const listChannels = db.prepare(channelList)
  const directMessage = db.prepare(`SELECT m.*, u.display_name, ${deletionFields}
    FROM messages m JOIN users u ON u.id = m.user_id ${joinDeletion} WHERE m.id = ?`)
  const latestDeletion = db.prepare('SELECT coalesce(max(revision), 0) AS version FROM message_deletions WHERE channel_id = ?')
  const deletionsAfter = db.prepare(`SELECT m.*, u.display_name, ${deletionFields}, d.revision
    FROM message_deletions d JOIN messages m ON m.id = d.message_id JOIN users u ON u.id = m.user_id
    JOIN users moderator ON moderator.id = d.user_id
    WHERE d.channel_id = ? AND d.revision > ? ORDER BY d.revision LIMIT 41`)
  const expiredAttachments = db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?')
  const cleanup = setInterval(() => {
    try { expiredAttachments.run(Date.now() - stagingTime) } catch (error) {
      console.error('Attachment cleanup failed', error.code ?? error.name)
    }
  }, 15 * 60 * 1000)
  cleanup.unref()
  const uploading = new Set()
  const posting = new Map()
  const showTopic = row => topicView(row, appearance)
  const showMessage = row => messageView(row, appearance.profile)

  function getTopic(userId, topicId, joined = false) {
    assertId(topicId)
    const topic = topicById.get(userId, topicId)
    if (!topic) throw missing()
    if (joined && !topic.joined_at) throw forbidden()
    return topic
  }

  function getChannel(userId, channelId, type) {
    assertId(channelId)
    const channel = findChannel.get(userId, channelId)
    if (!channel || (type && type !== channel.type)) throw missing()
    return channel
  }

  function channelAccess(userId, channelId) {
    const channel = findChannel.get(userId, channelId)
    if (channel?.type !== 'live') return null
    const canManage = channel.role === 'owner' || channel.role === 'admin'
    const canStream = channel.topic_stream_policy !== 'disabled' &&
      (canManage || (channel.topic_stream_policy === 'all' && channel.stream_policy === 'all'))
    return { canView: true, canManage, canStream }
  }

  function requireManager(role) {
    if (role !== 'owner' && role !== 'admin') throw forbidden()
  }

  function memberLimit(topicId) {
    if (db.prepare('SELECT count(*) AS count FROM topic_members WHERE topic_id = ?').get(topicId).count >= maxMembers) {
      throw new RequestError(409, 'Dieses Thema hat bereits die maximale Mitgliederzahl erreicht.')
    }
  }

  function mutateFriend(user, target, action) {
    assertId(target)
    if (target === user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) throw missing()
    const [first, second] = [user.id, target].sort()
    const relationship = db.prepare('SELECT * FROM friendships WHERE first_id = ? AND second_id = ?').get(first, second)
    if (action === 'request') {
      if (relationship) throw new RequestError(409, 'Für diese Person gibt es schon eine Anfrage oder Verbindung.')
      db.prepare('INSERT INTO friendships(first_id, second_id, requester_id) VALUES (?, ?, ?)').run(first, second, user.id)
    } else if (action === 'accept') {
      if (!relationship || relationship.accepted || relationship.requester_id === user.id) throw missing()
      db.prepare('UPDATE friendships SET accepted = 1 WHERE first_id = ? AND second_id = ?').run(first, second)
    } else {
      transaction(db, () => {
        db.prepare('DELETE FROM friendships WHERE first_id = ? AND second_id = ?').run(first, second)
        db.prepare(`DELETE FROM topic_members WHERE role <> 'owner' AND (
          (user_id = ? AND topic_id IN (SELECT id FROM topics WHERE owner_id = ? AND visibility = 'private')) OR
          (user_id = ? AND topic_id IN (SELECT id FROM topics WHERE owner_id = ? AND visibility = 'private'))
        )`).run(user.id, target, target, user.id)
      })
    }
  }

  function people(userId, query) {
    const search = query?.trim().normalize('NFC').toLowerCase().slice(0, 64) || null
    return db.prepare(`SELECT u.id, u.username, u.display_name, f.accepted, f.requester_id
      FROM users u LEFT JOIN friendships f ON (f.first_id = u.id AND f.second_id = ?) OR
      (f.second_id = u.id AND f.first_id = ?) WHERE u.id <> ? AND
      ((? IS NULL AND f.requester_id IS NOT NULL) OR
      (? IS NOT NULL AND (instr(u.username, ?) > 0 OR instr(lower(u.display_name), ?) > 0)))
      ORDER BY u.display_name LIMIT 80`).all(userId, userId, userId, search, search, search, search).map(row => ({
      id: row.id, username: row.username, displayName: row.display_name,
      ...appearance.profile(row.id),
      relationship: row.accepted ? 'friend' : row.requester_id === userId ? 'outgoing' : row.requester_id ? 'incoming' : null,
    }))
  }

  function createTopic(user, input, language) {
    const title = name(input.title, 72)
    const visibility = select(input.visibility, ['public', 'private'])
    const topicId = randomUUID()
    const now = new Date().toISOString()
    transaction(db, () => {
      db.prepare('INSERT INTO topics(id, owner_id, title, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(topicId, user.id, title, visibility, now)
      db.prepare("INSERT INTO topic_members(topic_id,user_id,role,approved,joined_at,visited_at) VALUES (?,?,'owner',1,?,?)")
        .run(topicId, user.id, now, now)
      const channel = db.prepare("INSERT INTO channels(id,topic_id,title,type,stream_policy) VALUES (?,?,?,?,'all')")
      channel.run(randomUUID(), topicId, language === 'de' ? 'Allgemein' : 'General', 'chat')
      channel.run(randomUUID(), topicId, 'Live', 'live')
    })
    return showTopic(getTopic(user.id, topicId))
  }

  function changeTopic(user, topic, input) {
    if (topic.role !== 'owner') throw forbidden()
    const title = input.title === undefined ? topic.title : name(input.title, 72)
    const visibility = input.visibility === undefined ? topic.visibility : select(input.visibility, ['public', 'private'])
    const streamPolicy = input.streamPolicy === undefined ? topic.stream_policy : select(input.streamPolicy, ['all', 'admins', 'disabled'])
    transaction(db, () => {
      if (topic.visibility !== visibility && visibility === 'private') {
        db.prepare(`DELETE FROM topic_members WHERE topic_id = ? AND role <> 'owner' AND (approved = 0 OR NOT EXISTS (
          SELECT 1 FROM friendships f WHERE f.accepted = 1 AND
          ((f.first_id = ? AND f.second_id = topic_members.user_id) OR (f.second_id = ? AND f.first_id = topic_members.user_id))
        ))`).run(topic.id, user.id, user.id)
      }
      db.prepare('UPDATE topics SET title = ?, visibility = ?, stream_policy = ? WHERE id = ?').run(title, visibility, streamPolicy, topic.id)
    })
    return showTopic(getTopic(user.id, topic.id))
  }

  function removeTopic(user, topic) {
    if (topic.owner_id !== user.id) throw forbidden()
    transaction(db, () => {
      const topicChannels = 'SELECT id FROM channels WHERE topic_id = ?'
      // Ending a broadcast prunes its chat and preserves the publisher ID for disconnection by the sweeper.
      db.prepare(`UPDATE broadcasts SET ended_at = ? WHERE ended_at IS NULL AND channel_id IN (${topicChannels})`)
        .run(Date.now(), topic.id)
      db.prepare(`DELETE FROM attachments WHERE channel_id IN (${topicChannels})`).run(topic.id)
      db.prepare(`DELETE FROM messages WHERE channel_id IN (${topicChannels})`).run(topic.id)
      db.prepare('DELETE FROM channels WHERE topic_id = ?').run(topic.id)
      db.prepare('DELETE FROM topic_members WHERE topic_id = ?').run(topic.id)
      db.prepare('DELETE FROM topics WHERE id = ?').run(topic.id)
    })
  }

  function join(user, topic) {
    if (topic.joined_at) return showTopic(topic)
    const now = new Date().toISOString()
    if (topic.visibility === 'private' && topic.approved !== 1) throw forbidden()
    if (!topic.role) memberLimit(topic.id)
    db.prepare(`INSERT INTO topic_members(topic_id,user_id,role,joined_at,visited_at) VALUES (?,?,'member',?,?)
      ON CONFLICT(topic_id,user_id) DO UPDATE SET joined_at = excluded.joined_at, visited_at = excluded.visited_at`)
      .run(topic.id, user.id, now, now)
    return showTopic(getTopic(user.id, topic.id))
  }

  function changeMember(user, topic, { userId, action }) {
    if (topic.role !== 'owner' || userId === user.id) throw forbidden()
    assertId(userId)
    select(action, ['invite', 'promote', 'demote', 'remove', 'grant-design', 'revoke-design'])
    const member = db.prepare('SELECT * FROM topic_members WHERE topic_id = ? AND user_id = ?').get(topic.id, userId)
    if (action === 'invite') {
      const [first, second] = [user.id, userId].sort()
      if (!db.prepare('SELECT 1 FROM friendships WHERE first_id = ? AND second_id = ? AND accepted = 1').get(first, second)) {
        throw new RequestError(403, 'Du kannst nur bestätigte Freunde für das Thema freigeben.')
      }
      if (!member) memberLimit(topic.id)
      db.prepare(`INSERT INTO topic_members(topic_id,user_id,role,approved) VALUES (?,?,'member',1)
        ON CONFLICT(topic_id,user_id) DO UPDATE SET approved = 1`).run(topic.id, userId)
    } else if (action === 'remove') {
      db.prepare('DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?').run(topic.id, userId)
    } else if (action === 'grant-design') {
      if (!member?.joined_at) throw missing()
      db.prepare('INSERT OR IGNORE INTO topic_designers(topic_id,user_id) VALUES (?,?)').run(topic.id, userId)
    } else if (action === 'revoke-design') {
      db.prepare('DELETE FROM topic_designers WHERE topic_id = ? AND user_id = ?').run(topic.id, userId)
    } else {
      if (!member?.joined_at) throw missing()
      db.prepare('UPDATE topic_members SET role = ? WHERE topic_id = ? AND user_id = ?')
        .run(action === 'promote' ? 'admin' : 'member', topic.id, userId)
    }
  }

  function topicDetails(user, topic) {
    if (!topic.joined_at) return { topic: showTopic(topic), channels: [], members: [] }
    topic.visited_at = new Date().toISOString()
    db.prepare('UPDATE topic_members SET visited_at = ? WHERE topic_id = ? AND user_id = ?')
      .run(topic.visited_at, topic.id, user.id)
    const channels = listChannels.all(topic.id)
    const members = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, m.role, m.joined_at
      FROM topic_members m JOIN users u ON u.id = m.user_id WHERE m.topic_id = ? AND (m.joined_at IS NOT NULL OR ? = 'owner')
      ORDER BY m.role = 'owner' DESC, m.role = 'admin' DESC, u.display_name`)
      .all(topic.id, topic.role).map(({ joined_at, ...member }) => ({ ...member, joined: Boolean(joined_at),
        canDesign: appearance.designPermission(topic.id, member.id, member.role, joined_at), ...appearance.profile(member.id),
      }))
    return { topic: showTopic(topic), channels, members }
  }

  function changeChannel(topicId, channel, input) {
    const title = input.title === undefined && channel ? channel.title : name(input.title, 72)
    const type = channel?.type ?? select(input.type, ['chat', 'live'])
    const streamPolicy = type === 'chat' ? 'all' : select(input.streamPolicy ?? channel?.stream_policy ?? 'all', ['all', 'admins'])
    const channelId = channel?.id ?? randomUUID()
    if (!channel && db.prepare('SELECT count(*) AS count FROM channels WHERE topic_id = ?').get(topicId).count >= 50) {
      throw new RequestError(409, 'Dieses Thema hat bereits 50 Kanäle.')
    }
    if (db.prepare('SELECT 1 FROM channels WHERE topic_id = ? AND title = ? AND id <> ?').get(topicId, title, channelId)) {
      throw new RequestError(409, 'In diesem Thema gibt es schon einen Kanal mit diesem Namen.')
    }
    if (channel) db.prepare('UPDATE channels SET title = ?, stream_policy = ? WHERE id = ?').run(title, streamPolicy, channelId)
    else db.prepare('INSERT INTO channels(id,topic_id,title,type,stream_policy) VALUES (?,?,?,?,?)')
      .run(channelId, topicId, title, type, streamPolicy)
    return { id: channelId, title, type, streamPolicy }
  }

  function messagePage(user, channel, params) {
    const after = params.has('after') ? Number(params.get('after')) : null
    const before = params.has('before') ? Number(params.get('before')) : null
    const grantsAfter = params.get('grantsAfter')
    const afterDeletion = params.get('deletionsAfter')
    const cursor = after ?? before ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (after !== null && before !== null)) {
      throw new RequestError(400, 'Ungültige Position im Chatverlauf.')
    }
    const historyVersion = db.prepare(`SELECT coalesce(max(g.revision), 0) AS version FROM message_history_grants g
      JOIN messages m ON m.id = g.message_id WHERE g.recipient_id = ? AND m.channel_id = ?`).get(user.id, channel.id).version
    if (grantsAfter !== null) {
      const afterGrant = Number(grantsAfter)
      if (before !== null || after !== null || afterDeletion !== null || !/^\d+$/.test(grantsAfter) || !Number.isSafeInteger(afterGrant)) {
        throw new RequestError(400, 'Ungültige Position bei den Verlaufsfreigaben.')
      }
      const granted = db.prepare(`SELECT m.*, u.display_name, ${historyFields}, ${deletionFields}, g.revision FROM message_history_grants g
        JOIN messages m ON m.id = g.message_id JOIN users u ON u.id = m.user_id ${joinDeletion}
        WHERE g.recipient_id = ? AND g.revision > ? AND m.channel_id = ? ORDER BY g.revision LIMIT 41`)
        .all(user.id, afterGrant, channel.id)
      const page = granted.slice(0, 40)
      return { messages: page.map(showMessage), more: granted.length > 40, historyVersion,
        nextGrantVersion: page.at(-1)?.revision ?? afterGrant }
    }
    const deletionVersion = latestDeletion.get(channel.id).version
    let deletionUpdates = {}
    if (afterDeletion !== null) {
      const version = Number(afterDeletion)
      if (before !== null || !/^\d+$/.test(afterDeletion) || !Number.isSafeInteger(version)) {
        throw new RequestError(400, 'Ungültige Position bei gelöschten Nachrichten.')
      }
      const deleted = version < deletionVersion ? deletionsAfter.all(channel.id, version) : []
      const page = deleted.slice(0, 40)
      deletionUpdates = { deletions: page.map(showMessage), moreDeletions: deleted.length > 40,
        nextDeletionVersion: page.at(-1)?.revision ?? version }
    }
    const rows = db.prepare(`SELECT m.*, u.display_name, ${historyFields}, ${deletionFields}
      FROM messages m JOIN users u ON u.id = m.user_id
      ${joinHistory} ${joinDeletion}
      WHERE m.channel_id = ? AND m.seq ${after === null ? '<' : '>'} ? AND
      (d.revision IS NOT NULL OR g.revision IS NOT NULL OR ${originalAccess})
      ORDER BY m.seq ${after === null ? 'DESC' : 'ASC'} LIMIT 41`)
      .all(user.id, channel.id, cursor, user.id)
    const messages = rows.slice(0, 40).map(showMessage)
    return {
      messages: after === null ? messages.reverse() : messages, more: rows.length > 40, historyVersion, deletionVersion, ...deletionUpdates,
      recipients: recipientKeys.all(channel.topic_id).map(({ id, public_key }) => ({ id, publicKey: JSON.parse(public_key) })),
    }
  }

  function recentActivity(user, topic) {
    if (!topic.joined_at) throw forbidden()
    return db.prepare(`SELECT m.*, u.display_name, c.title AS channel_title, ${historyFields} FROM messages m
      JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id ${joinHistory}
      WHERE c.topic_id = ? AND ${undeleted} AND (g.revision IS NOT NULL OR ${originalAccess})
      ORDER BY m.seq DESC LIMIT 16`).all(user.id, topic.id, user.id).map(row => ({
      ...showMessage(row), channelId: row.channel_id, channelTitle: row.channel_title,
    }))
  }

  function homeActivity(userId) {
    return db.prepare(`SELECT m.*, u.display_name, c.title AS channel_title, t.id AS topic_id, t.title AS topic_title, ${historyFields}
      FROM messages m JOIN channels c ON c.id = m.channel_id JOIN topics t ON t.id = c.topic_id
      JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = ? AND tm.joined_at IS NOT NULL
      JOIN users u ON u.id = m.user_id ${joinHistory}
      WHERE ${undeleted} AND (g.revision IS NOT NULL OR ${originalAccess})
      ORDER BY m.seq DESC LIMIT 16`).all(userId, userId, userId).map(row => ({
      ...showMessage(row), topicId: row.topic_id, topicTitle: row.topic_title,
      channelId: row.channel_id, channelTitle: row.channel_title,
    }))
  }

  function post(user, channel, input) {
    assertId(input.id)
    const ids = input.attachmentIds
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !uuid.test(id))) {
      throw new RequestError(400, 'Ungültige Anhänge.')
    }
    const existing = directMessage.get(input.id)
    if (existing) {
      if (existing.channel_id === channel.id && existing.user_id === user.id) return showMessage(existing)
      throw new RequestError(409, 'Diese Nachricht wurde bereits verwendet.')
    }
    const time = Date.now()
    for (const [id, entry] of posting) if (entry.until <= time) posting.delete(id)
    const attempts = posting.get(user.id) ?? { count: 0, until: time + 10000 }
    if (attempts.count >= 15) throw new RequestError(429, 'Warte einen Moment, bevor du erneut schreibst.')
    attempts.count++
    posting.set(user.id, attempts)

    const envelope = validateEnvelope(input.envelope, recipientKeys.all(channel.topic_id))
    const createdAt = new Date(time).toISOString()
    const seq = transaction(db, () => {
      const result = db.prepare('INSERT INTO messages(id,channel_id,user_id,envelope,created_at) VALUES (?,?,?,?,?)')
        .run(input.id, channel.id, user.id, envelope, createdAt)
      const linkFile = db.prepare(`UPDATE attachments SET message_id = ? WHERE id = ? AND channel_id = ?
        AND user_id = ? AND message_id IS NULL AND created_at >= ?`)
      for (const id of ids) if (linkFile.run(input.id, id, channel.id, user.id, time - stagingTime).changes !== 1) {
        throw new RequestError(409, 'Ein Anhang fehlt oder wurde schon versendet. Lade ihn erneut hoch.')
      }
      recordMentions({ channelId: channel.id, senderId: user.id, messageId: input.id, mentionedUserIds: input.mentionedUserIds })
      return Number(result.lastInsertRowid)
    })
    return showMessage({ id: input.id, seq, user_id: user.id, display_name: user.displayName, created_at: createdAt, envelope })
  }

  function removeMessage(request, channelId, messageId, input) {
    assertId(messageId)
    return transaction(db, () => {
      const actor = requireSession(request)
      const channel = getChannel(actor.id, channelId, 'chat')
      const row = directMessage.get(messageId)
      if (!row || row.channel_id !== channel.id) throw missing()
      const own = row.user_id === actor.id
      if (!own) requireManager(channel.role)
      if (row.deleted_at) return showMessage(row)
      let reason = 'null'
      if (!own) {
        const content = input.reason?.body
        if (typeof content !== 'string' || content.length < 40 || content.length > 1900 || content === JSON.parse(row.envelope).body) {
          throw new RequestError(400, 'Gib einen verschlüsselten Grund für die Löschung an.')
        }
        reason = validateEnvelope(input.reason, recipientKeys.all(channel.topic_id))
      }
      db.prepare('UPDATE messages SET envelope = ? WHERE id = ?').run(reason, row.id)
      db.prepare('DELETE FROM attachments WHERE message_id = ?').run(row.id)
      db.prepare('DELETE FROM message_history_grants WHERE message_id = ?').run(row.id)
      db.prepare('INSERT INTO message_deletions(message_id,channel_id,user_id,deleted_at) VALUES (?,?,?,?)')
        .run(row.id, channel.id, actor.id, new Date().toISOString())
      return showMessage(directMessage.get(row.id))
    })
  }

  async function putFile(request, user, channel, fileId) {
    assertId(fileId)
    if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, 'Nur verschlüsselte Dateien sind erlaubt.')
    if (uploading.has(user.id) || uploading.size >= 4) throw new RequestError(429, 'Warte, bis andere Uploads abgeschlossen sind.')
    uploading.add(user.id)
    try {
      const bytes = await readBytes(request, fileLimit)
      if (bytes.length < 28) throw new RequestError(400, 'Die verschlüsselte Datei ist ungültig.')
      const currentUser = requireSession(request)
      getChannel(currentUser.id, channel.id, 'chat')
      const now = Date.now()
      expiredAttachments.run(now - stagingTime)
      transaction(db, () => {
        const previous = db.prepare('SELECT channel_id,user_id,message_id,size FROM attachments WHERE id = ?').get(fileId)
        if (previous && (previous.channel_id !== channel.id || previous.user_id !== user.id || previous.message_id)) {
          throw new RequestError(409, 'Dieser Anhang wurde bereits verwendet.')
        }
        const fileSizeIncrease = bytes.length - (previous?.size ?? 0)
        const used = db.prepare('SELECT coalesce(sum(size),0) AS total FROM attachments').get().total
        const usedBySender = db.prepare('SELECT coalesce(sum(size),0) AS total FROM attachments WHERE user_id = ?').get(user.id).total
        if (used + fileSizeIncrease > totalFileLimit || usedBySender + fileSizeIncrease > userFileLimit) {
          throw new RequestError(413, 'Der Speicher für Anhänge ist voll.')
        }
        db.prepare(`INSERT INTO attachments(id,channel_id,user_id,bytes,size,created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, size = excluded.size, created_at = excluded.created_at`)
          .run(fileId, channel.id, user.id, bytes, bytes.length, now)
      })
    } finally {
      uploading.delete(user.id)
    }
  }

  function getFile(response, user, channel, fileId, limit) {
    assertId(fileId)
    if (limit !== null && (!/^[1-9]\d{0,7}$/u.test(limit) || Number(limit) > fileLimit)) {
      throw new RequestError(400, 'Ungültige Auswahl.')
    }
    const file = db.prepare(`SELECT CASE WHEN a.size <= ? THEN a.bytes END AS bytes, a.size
      FROM attachments a JOIN messages m ON m.id = a.message_id
      ${joinHistory} WHERE a.id = ? AND a.channel_id = ? AND ${undeleted} AND (g.revision IS NOT NULL OR ${originalAccess})`)
      .get(limit === null ? fileLimit : Number(limit), user.id, fileId, channel.id, user.id)
    if (!file) throw missing()
    if (file.bytes === null) return response.writeHead(204).end()
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
      'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox" })
    response.end(file.bytes)
  }

  async function handle(request, response, url) {
    const { pathname: path, searchParams } = url
    const method = request.method
    const [api, resource, id, action, file, extra] = path.slice(1).split('/')
    if (api !== 'api' || extra !== undefined) return false
    requireSession(request)
    const body = ['POST', 'PATCH'].includes(method) ? await readJson(request, action === 'messages' ? 65536 : 8192) : null
    const user = requireSession(request)
    if (resource === 'people' && !id && method === 'GET') {
      json(response, 200, { people: people(user.id, searchParams.get('query')) })
    } else if (resource === 'friends' && id && !action && method === 'POST') {
      mutateFriend(user, id, select(body.action, ['request', 'accept', 'remove']))
      json(response, 200, { ok: true })
    } else if (resource === 'topics' && !id) {
      if (method === 'GET') json(response, 200, { topics: listTopics.all(user.id).map(showTopic) })
      else if (method === 'POST') json(response, 201, { topic: createTopic(user, body, responseLocale(response)) })
      else return false
    } else if (resource === 'topics' && id && !file) {
      const topic = getTopic(user.id, id)
      if (method === 'GET' && !action) json(response, 200, topicDetails(user, topic))
      else if (method === 'GET' && action === 'activity') json(response, 200, { activities: recentActivity(user, topic) })
      else if (method === 'PATCH' && !action) json(response, 200, { topic: changeTopic(user, topic, body) })
      else if (method === 'DELETE' && !action) {
        removeTopic(user, topic)
        response.writeHead(204).end()
      }
      else if (method === 'POST' && action === 'join') json(response, 200, { topic: join(user, topic) })
      else if (method === 'DELETE' && action === 'join') {
        if (topic.role === 'owner') throw forbidden()
        if (topic.approved && topic.joined_at) {
          transaction(db, () => {
            db.prepare('DELETE FROM topic_designers WHERE topic_id = ? AND user_id = ?').run(id, user.id)
            db.prepare("UPDATE topic_members SET joined_at = NULL, visited_at = NULL, favorite = 0, role = 'member' WHERE topic_id = ? AND user_id = ?")
              .run(id, user.id)
          })
        } else db.prepare('DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?').run(id, user.id)
        json(response, 200, { ok: true })
      } else if (method === 'POST' && action === 'favorite') {
        if (!topic.joined_at) throw forbidden()
        if (typeof body.favorite !== 'boolean') throw new RequestError(400, 'Ungültiger Favorit.')
        db.prepare('UPDATE topic_members SET favorite = ? WHERE topic_id = ? AND user_id = ?').run(Number(body.favorite), id, user.id)
        json(response, 200, { ok: true })
      } else if (method === 'POST' && action === 'members') {
        changeMember(user, topic, body)
        json(response, 200, { ok: true })
      } else if (method === 'POST' && action === 'channels') {
        requireManager(topic.joined_at && topic.role)
        json(response, 201, { channel: changeChannel(topic.id, null, body) })
      } else return false
    } else if (resource === 'channels' && id) {
      if (method === 'PATCH' && !action) {
        const channel = getChannel(user.id, id)
        requireManager(channel.role)
        json(response, 200, { channel: changeChannel(channel.topic_id, channel, body) })
      } else if (action === 'messages' && file && method === 'DELETE') {
        getChannel(user.id, id, 'chat')
        const deletion = await readJson(request, 16384)
        json(response, 200, { message: removeMessage(request, id, file, deletion) })
      } else if (action === 'messages' && !file) {
        const channel = getChannel(user.id, id, 'chat')
        if (method === 'GET') json(response, 200, messagePage(user, channel, searchParams))
        else if (method === 'POST') json(response, 201, { message: post(user, channel, body) })
        else return false
      } else if (action === 'files' && file) {
        const channel = getChannel(user.id, id, 'chat')
        if (method === 'PUT') {
          await putFile(request, user, channel, file)
          json(response, 201, { id: file })
        } else if (method === 'GET') getFile(response, user, channel, file, searchParams.get('maxBytes'))
        else return false
      } else return false
    } else return false
    return true
  }

  return { handle, channelAccess, homeActivity,
    chatKeys: channelId => {
      const channel = channelTopic.get(channelId)
      return channel ? recipientKeys.all(channel.topic_id) : []
    },
    close: () => clearInterval(cleanup) }
}
