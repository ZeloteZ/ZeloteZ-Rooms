import { createPublicKey } from 'node:crypto'
import { json, readJson, RequestError, transaction } from './http.mjs'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const idPattern = new RegExp(`^${uuid}$`)
const route = new RegExp(`^/api/channels/(${uuid})/history-grants$`)
const pendingRoute = '/api/history/pending'
const batchLimit = 50
const missing = () => new RequestError(404, 'Dieser Chat oder dieses Mitglied ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Verlaufsfreigabe.')
const originalSlot = user => `EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ${user})`
const grantedSlot = user => `EXISTS (SELECT 1 FROM message_history_grants g WHERE g.message_id = m.id AND g.recipient_id = ${user})`
const readable = user => `(${originalSlot(user)} OR ${grantedSlot(user)})`
const hasContent = "m.envelope <> 'null'"
const needsKey = user => `${hasContent} AND NOT ${originalSlot(user)} AND NOT ${grantedSlot(user)}`

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function encoded(value, bytes) {
  return typeof value === 'string' && value.length === Math.ceil(bytes * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
}

function grantEnvelope(wrapper) {
  if (!exactFields(wrapper, ['v', 'ephemeral', 'nonce', 'blob']) || wrapper.v !== 1 ||
      !encoded(wrapper.nonce, 12) || !encoded(wrapper.blob, 48)) throw invalid()
  const point = wrapper.ephemeral
  if (!exactFields(point, ['kty', 'crv', 'x', 'y']) || point.kty !== 'EC' || point.crv !== 'P-256' ||
      !encoded(point.x, 32) || !encoded(point.y, 32)) throw invalid()
  try {
    createPublicKey({ key: point, format: 'jwk' })
  } catch {
    throw invalid()
  }
  return JSON.stringify(wrapper)
}

function numberParam(params, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = params.get(name)
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) throw invalid()
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw invalid()
  return number
}

function pendingCursor(params) {
  const value = params.get('cursor')
  if (value === null) return { jobId: 0, before: null }
  if (!/^[1-9]\d{0,15}(?:\.[1-9]\d{0,15})?$/.test(value)) throw invalid()
  const [jobId, before = null] = value.split('.').map(Number)
  if (!Number.isSafeInteger(jobId) || (before !== null && !Number.isSafeInteger(before))) throw invalid()
  return { jobId, before }
}

export function createHistory(db, { requireSession }) {
  const queueExisting = (targetFilter = '') => `INSERT INTO history_share_jobs
    (topic_id, channel_id, recipient_id, admitted_at, latest_sequence)
    SELECT member.topic_id, c.id, member.user_id, member.joined_at,
      (SELECT max(seq) FROM messages WHERE channel_id = c.id)
    FROM topic_members member JOIN channels c ON c.topic_id = member.topic_id AND c.type = 'chat'
    WHERE member.joined_at IS NOT NULL ${targetFilter} AND EXISTS (
      SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.created_at <= member.joined_at AND ${needsKey('member.user_id')})
    ON CONFLICT(channel_id, recipient_id) DO UPDATE SET complete = 0`

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_history_grants (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wrapper TEXT NOT NULL CHECK (json_valid(wrapper)),
      CHECK (grantor_id <> recipient_id),
      UNIQUE(message_id, recipient_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS history_grants_recipient ON message_history_grants(recipient_id, revision);

    CREATE TABLE IF NOT EXISTS history_share_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      latest_sequence INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
      FOREIGN KEY(topic_id, recipient_id) REFERENCES topic_members(topic_id, user_id) ON DELETE CASCADE,
      UNIQUE(channel_id, recipient_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS history_jobs_pending ON history_share_jobs(id) WHERE complete = 0;
    CREATE INDEX IF NOT EXISTS history_jobs_membership ON history_share_jobs(topic_id, recipient_id);
    CREATE TABLE IF NOT EXISTS history_migrations (version INTEGER PRIMARY KEY) STRICT;

    DROP TRIGGER IF EXISTS history_jobs_on_join_insert;
    CREATE TRIGGER history_jobs_on_join_insert AFTER INSERT ON topic_members
      WHEN NEW.joined_at IS NOT NULL BEGIN
        ${queueExisting('AND member.topic_id = NEW.topic_id AND member.user_id = NEW.user_id')};
      END;

    DROP TRIGGER IF EXISTS history_jobs_on_join_update;
    CREATE TRIGGER history_jobs_on_join_update AFTER UPDATE OF joined_at ON topic_members
      WHEN OLD.joined_at IS NOT NEW.joined_at BEGIN
        DELETE FROM history_share_jobs WHERE topic_id = OLD.topic_id AND recipient_id = OLD.user_id;
        ${queueExisting('AND member.topic_id = NEW.topic_id AND member.user_id = NEW.user_id')};
      END;

    DROP TRIGGER IF EXISTS history_jobs_on_message_delete;
    CREATE TRIGGER history_jobs_on_message_delete AFTER INSERT ON message_deletions BEGIN
      UPDATE history_share_jobs SET complete = 1
      WHERE channel_id = NEW.channel_id AND complete = 0 AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.channel_id = history_share_jobs.channel_id AND m.seq <= history_share_jobs.latest_sequence
          AND m.created_at <= history_share_jobs.admitted_at AND ${needsKey('history_share_jobs.recipient_id')}
      );
    END;
  `)
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM history_migrations WHERE version = 2').get()) return
    db.exec(queueExisting())
    db.exec('INSERT OR IGNORE INTO history_migrations(version) VALUES (1), (2)')
  })

  const chatFor = db.prepare(`SELECT c.topic_id FROM channels c JOIN topic_members tm
    ON tm.topic_id = c.topic_id AND tm.user_id = ? AND tm.joined_at IS NOT NULL
    WHERE c.id = ? AND c.type = 'chat'`)
  const receiver = db.prepare(`SELECT user_id AS id, joined_at FROM topic_members
    WHERE topic_id = ? AND user_id = ? AND joined_at IS NOT NULL`)

  const eligible = db.prepare(`SELECT m.id, m.seq,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN m.envelope ELSE held.wrapper END, '$.ephemeral') AS ephemeral,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN mine.value ELSE held.wrapper END, '$.nonce') AS nonce,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN mine.value ELSE held.wrapper END, '$.blob') AS blob,
    CASE WHEN mine.key IS NULL THEN held.grantor_id END AS grantorId,
    d.revision AS deletionRevision
    FROM messages m LEFT JOIN json_each(m.envelope, '$.keys') mine ON mine.key = ?
    LEFT JOIN message_history_grants held ON held.message_id = m.id AND held.recipient_id = ?
    LEFT JOIN message_deletions d ON d.message_id = m.id
    WHERE m.channel_id = ? AND m.seq < ? AND m.created_at <= ? AND ${needsKey('?')}
      AND (mine.key IS NOT NULL OR held.revision IS NOT NULL)
    ORDER BY m.seq DESC LIMIT ?`)
  const grantable = db.prepare(`SELECT m.id FROM messages m WHERE m.channel_id = ? AND m.id = ? AND m.created_at <= ?
    AND ${hasContent} AND ${readable('?')} AND NOT ${originalSlot('?')}
    AND (SELECT revision FROM message_deletions WHERE message_id = m.id) IS ?`)
  const add = db.prepare(`INSERT INTO message_history_grants(message_id, recipient_id, grantor_id, wrapper)
    VALUES (?,?,?,?) ON CONFLICT(message_id, recipient_id) DO NOTHING`)
  const pendingJobs = `SELECT j.*, u.public_key FROM history_share_jobs j
    JOIN topic_members actor ON actor.topic_id = j.topic_id AND actor.user_id = ? AND actor.joined_at IS NOT NULL
    JOIN topic_members recipient ON recipient.topic_id = j.topic_id AND recipient.user_id = j.recipient_id
      AND recipient.joined_at = j.admitted_at
    JOIN users u ON u.id = j.recipient_id
    WHERE j.complete = 0 AND j.recipient_id <> actor.user_id`
  const resumeJob = db.prepare(`${pendingJobs} AND j.id = ?`)
  const nextJob = db.prepare(`${pendingJobs} AND j.id > ? AND EXISTS (
    SELECT 1 FROM messages m WHERE m.channel_id = j.channel_id AND m.seq <= j.latest_sequence
      AND m.created_at <= j.admitted_at AND ${needsKey('j.recipient_id')} AND ${readable('actor.user_id')})
    ORDER BY j.id LIMIT 1`)
  const completeJob = db.prepare(`UPDATE history_share_jobs AS j SET complete = 1
    WHERE j.channel_id = ? AND j.recipient_id = ? AND j.complete = 0 AND NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.channel_id = j.channel_id AND m.seq <= j.latest_sequence
        AND m.created_at <= j.admitted_at AND ${needsKey('j.recipient_id')})`)

  function topicFor(actorId, channelId) {
    const channel = chatFor.get(actorId, channelId)
    if (!channel) throw missing()
    return channel.topic_id
  }

  function recipientFor(topicId, actorId, recipientId) {
    if (typeof recipientId !== 'string' || !idPattern.test(recipientId) || recipientId === actorId) throw invalid()
    const recipient = receiver.get(topicId, recipientId)
    if (!recipient) throw missing()
    return recipient
  }

  function keyPage(actorId, channelId, recipient, before, limit) {
    const rows = eligible.all(actorId, actorId, channelId, before, recipient.joined_at, recipient.id, recipient.id, limit + 1)
    const messages = rows.slice(0, limit).map(({ ephemeral, grantorId, deletionRevision, ...box }) => ({
      ...box, ephemeral: JSON.parse(ephemeral), ...(grantorId ? { grantorId } : {}),
      ...(deletionRevision === null ? {} : { deletionRevision }),
    }))
    return {
      recipient: { id: recipient.id, publicKey: JSON.parse(recipient.public_key) }, messages,
      nextBefore: rows.length > limit ? messages.at(-1).seq : null,
    }
  }

  function pendingPage(actorId, params) {
    const { jobId, before } = pendingCursor(params)
    const limit = numberParam(params, 'limit', batchLimit, batchLimit)
    const keysFor = (job, cursor = Number.MAX_SAFE_INTEGER) => keyPage(actorId, job.channel_id, {
      joined_at: job.admitted_at, id: job.recipient_id, public_key: job.public_key,
    }, Math.min(cursor, job.latest_sequence + 1), limit)
    const response = (job, keys) => ({
      grantorId: actorId,
      job: { channelId: job.channel_id, recipient: keys.recipient, messages: keys.messages },
      nextCursor: keys.nextBefore === null ? String(job.id) : `${job.id}.${keys.nextBefore}`,
    })

    if (before !== null) {
      const job = resumeJob.get(actorId, jobId)
      if (job) {
        const keys = keysFor(job, before)
        if (keys.messages.length) return response(job, keys)
      }
    }
    const job = nextJob.get(actorId, jobId)
    return job ? response(job, keysFor(job)) : { grantorId: actorId, job: null, nextCursor: null }
  }

  function createBatch(request, channelId, input) {
    if (!exactFields(input, ['grantorId', 'recipientId', 'grants']) || !Array.isArray(input.grants) ||
        input.grants.length < 1 || input.grants.length > batchLimit) throw invalid()
    const ids = new Set()
    const entries = input.grants.map(entry => {
      const deletion = entry && Object.hasOwn(entry, 'deletionRevision')
      if (!exactFields(entry, deletion ? ['messageId', 'wrapper', 'deletionRevision'] : ['messageId', 'wrapper']) ||
          (deletion && (!Number.isSafeInteger(entry.deletionRevision) || entry.deletionRevision < 1)) ||
          typeof entry.messageId !== 'string' ||
          !idPattern.test(entry.messageId) || ids.has(entry.messageId)) throw invalid()
      ids.add(entry.messageId)
      return { messageId: entry.messageId, wrapper: grantEnvelope(entry.wrapper), deletionRevision: entry.deletionRevision ?? null }
    })
    return transaction(db, () => {
      const actor = requireSession(request)
      if (input.grantorId !== actor.id) throw new RequestError(409, 'Das angemeldete Konto hat sich geändert.')
      const topicId = topicFor(actor.id, channelId)
      const recipient = recipientFor(topicId, actor.id, input.recipientId)
      let granted = 0
      for (const entry of entries) {
        if (!grantable.get(channelId, entry.messageId, recipient.joined_at, actor.id, actor.id, recipient.id, entry.deletionRevision)) {
          throw new RequestError(409, 'Mindestens eine Nachricht kann für dieses Mitglied nicht freigegeben werden.')
        }
        granted += Number(add.run(entry.messageId, recipient.id, actor.id, entry.wrapper).changes)
      }
      completeJob.run(channelId, recipient.id)
      return { granted, alreadyShared: entries.length - granted }
    })
  }

  async function handle(request, response, { pathname, searchParams }) {
    if (pathname === pendingRoute) {
      const actor = requireSession(request)
      if (request.method !== 'GET') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
      json(response, 200, pendingPage(actor.id, searchParams))
      return true
    }
    const match = route.exec(pathname)
    if (!match) return false
    const [, channelId] = match
    const actor = requireSession(request)
    topicFor(actor.id, channelId)
    if (request.method !== 'POST') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    const input = await readJson(request, 32768)
    json(response, 200, createBatch(request, channelId, input))
    return true
  }

  return { handle }
}
