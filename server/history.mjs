import { createPublicKey } from 'node:crypto'
import { json, readJson, RequestError, transaction } from './http.mjs'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const idPattern = new RegExp(`^${uuid}$`)
const route = new RegExp(`^/api/channels/(${uuid})/history-(grants|rejections)$`)
const pendingRoute = '/api/history/pending'
const batchLimit = 50
const retryAfter = 30
const maxFailuresPerGrantor = 2
const maxGrants = 4_000_000
const maxRejections = 500_000
const missing = () => new RequestError(404, 'Dieser Chat oder dieses Mitglied ist nicht verfügbar.')
const invalid = () => new RequestError(400, 'Ungültige Verlaufsfreigabe.')
const full = () => new RequestError(507, 'Der Speicher für Verlaufsfreigaben ist voll.')
const originalSlot = user => `EXISTS (SELECT 1 FROM json_each(m.envelope, '$.keys') WHERE key = ${user})`
const grantedSlot = user => `EXISTS (SELECT 1 FROM message_history_grants g WHERE g.message_id = m.id AND g.recipient_id = ${user})`
const readable = user => `(${originalSlot(user)} OR ${grantedSlot(user)})`
const hasContent = "m.envelope <> 'null'"
const needsKey = user => `${hasContent} AND NOT ${originalSlot(user)} AND NOT ${grantedSlot(user)}`
const acceptsGrantor = (recipient, grantor) => `NOT EXISTS (SELECT 1 FROM message_history_rejections r
  WHERE r.message_id = m.id AND r.recipient_id = ${recipient} AND r.grantor_id = ${grantor}
    AND (r.failures >= ${maxFailuresPerGrantor} OR r.retry_at > unixepoch()))`

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
  const queueExisting = (targetFilter = '', messageFilter = '') => `INSERT INTO history_share_jobs
    (topic_id, channel_id, recipient_id, admitted_at, latest_sequence)
    SELECT member.topic_id, c.id, member.user_id, member.joined_at,
      (SELECT max(seq) FROM messages WHERE channel_id = c.id)
    FROM topic_members member JOIN channels c ON c.topic_id = member.topic_id
    WHERE member.joined_at IS NOT NULL ${targetFilter}
    AND NOT EXISTS (SELECT 1 FROM quick_rooms q WHERE q.topic_id = c.topic_id)
    AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.topic_id = member.topic_id) AND EXISTS (
      SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.created_at <= member.joined_at
        ${messageFilter} AND ${needsKey('member.user_id')})
    ON CONFLICT(channel_id, recipient_id) DO UPDATE SET complete = 0,
      latest_sequence = max(history_share_jobs.latest_sequence, excluded.latest_sequence)`

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

    CREATE TABLE IF NOT EXISTS message_history_rejections (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      failures INTEGER NOT NULL,
      retry_at INTEGER NOT NULL,
      PRIMARY KEY(message_id, recipient_id, grantor_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS history_storage_usage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      grants INTEGER NOT NULL CHECK (grants >= 0),
      rejections INTEGER NOT NULL CHECK (rejections >= 0)
    ) STRICT;
    INSERT INTO history_storage_usage
      SELECT 1, (SELECT count(*) FROM message_history_grants), (SELECT count(*) FROM message_history_rejections)
      WHERE NOT EXISTS (SELECT 1 FROM history_storage_usage);
    CREATE TRIGGER IF NOT EXISTS history_storage_granted AFTER INSERT ON message_history_grants
      BEGIN UPDATE history_storage_usage SET grants = grants + 1; END;
    CREATE TRIGGER IF NOT EXISTS history_storage_ungranted AFTER DELETE ON message_history_grants
      BEGIN UPDATE history_storage_usage SET grants = grants - 1; END;
    CREATE TRIGGER IF NOT EXISTS history_storage_rejected AFTER INSERT ON message_history_rejections
      BEGIN UPDATE history_storage_usage SET rejections = rejections + 1; END;
    CREATE TRIGGER IF NOT EXISTS history_storage_unrejected AFTER DELETE ON message_history_rejections
      BEGIN UPDATE history_storage_usage SET rejections = rejections - 1; END;

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
      DELETE FROM message_history_rejections WHERE message_id = NEW.message_id;
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
    WHERE c.id = ? AND NOT EXISTS (SELECT 1 FROM quick_rooms q WHERE q.topic_id = c.topic_id)
    AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.topic_id = c.topic_id)`)
  const receiver = db.prepare(`SELECT user_id AS id, joined_at FROM topic_members
    WHERE topic_id = ? AND user_id = ? AND joined_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = topic_members.user_id)`)

  const eligible = db.prepare(`SELECT m.id, m.seq, m.crypto_channel_id AS cryptoChannelId,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN m.envelope ELSE held.wrapper END, '$.ephemeral') AS ephemeral,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN mine.value ELSE held.wrapper END, '$.nonce') AS nonce,
    json_extract(CASE WHEN mine.key IS NOT NULL THEN mine.value ELSE held.wrapper END, '$.blob') AS blob,
    json_extract(m.envelope, '$.nonce') AS messageNonce,
    json_extract(m.envelope, '$.body') AS messageBody,
    CASE WHEN mine.key IS NULL THEN held.grantor_id END AS grantorId,
    CASE WHEN mine.key IS NULL THEN held.revision END AS grantRevision,
    d.revision AS deletionRevision
    FROM messages m LEFT JOIN json_each(m.envelope, '$.keys') mine ON mine.key = ?
    LEFT JOIN message_history_grants held ON held.message_id = m.id AND held.recipient_id = ?
    LEFT JOIN message_deletions d ON d.message_id = m.id
    WHERE m.channel_id = ? AND m.seq < ? AND m.created_at <= ? AND ${needsKey('?')} AND ${acceptsGrantor('?', '?')}
      AND (mine.key IS NOT NULL OR held.revision IS NOT NULL)
    ORDER BY m.seq DESC LIMIT ?`)
  const grantable = db.prepare(`SELECT m.id FROM messages m WHERE m.channel_id = ? AND m.id = ? AND m.created_at <= ?
    AND ${hasContent} AND ${readable('?')} AND NOT ${originalSlot('?')} AND ${acceptsGrantor('?', '?')}
    AND (SELECT revision FROM message_deletions WHERE message_id = m.id) IS ?`)
  const add = db.prepare(`INSERT INTO message_history_grants(message_id, recipient_id, grantor_id, wrapper)
    VALUES (?,?,?,?) ON CONFLICT(message_id, recipient_id) DO NOTHING`)
  const storage = db.prepare('SELECT grants, rejections FROM history_storage_usage WHERE id = 1')
  const existingGrant = db.prepare('SELECT 1 FROM message_history_grants WHERE message_id = ? AND recipient_id = ?')
  const existingRejection = db.prepare('SELECT 1 FROM message_history_rejections WHERE message_id = ? AND recipient_id = ? AND grantor_id = ?')
  const rejectable = db.prepare(`SELECT g.grantor_id FROM message_history_grants g
    JOIN messages m ON m.id = g.message_id WHERE m.channel_id = ? AND m.id = ? AND g.recipient_id = ? AND g.revision = ?`)
  const rememberRejection = db.prepare(`INSERT INTO message_history_rejections(message_id, recipient_id, grantor_id, failures, retry_at)
    VALUES (?,?,?,1,unixepoch() + ?) ON CONFLICT(message_id, recipient_id, grantor_id)
    DO UPDATE SET failures = failures + 1, retry_at = excluded.retry_at`)
  const removeRejected = db.prepare('DELETE FROM message_history_grants WHERE revision = ?')
  const reopen = db.prepare(queueExisting('AND member.topic_id = ? AND member.user_id = ? AND c.id = ?'))
  const queueMoved = db.prepare(queueExisting('AND c.id = ?', 'AND m.id = ?'))
  const pendingJobs = `SELECT j.*, u.public_key FROM history_share_jobs j
    JOIN topic_members actor ON actor.topic_id = j.topic_id AND actor.user_id = ? AND actor.joined_at IS NOT NULL
    JOIN topic_members recipient ON recipient.topic_id = j.topic_id AND recipient.user_id = j.recipient_id
      AND recipient.joined_at = j.admitted_at
    JOIN users u ON u.id = j.recipient_id
    WHERE j.complete = 0 AND j.recipient_id <> actor.user_id
      AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.topic_id = j.topic_id)
      AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.user_id = j.recipient_id)`
  const resumeJob = db.prepare(`${pendingJobs} AND j.id = ?`)
  const nextJob = db.prepare(`${pendingJobs} AND j.id > ? AND EXISTS (
    SELECT 1 FROM messages m WHERE m.channel_id = j.channel_id AND m.seq <= j.latest_sequence
      AND m.created_at <= j.admitted_at AND ${needsKey('j.recipient_id')}
      AND ${acceptsGrantor('j.recipient_id', 'actor.user_id')} AND ${readable('actor.user_id')})
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
    const rows = eligible.all(actorId, actorId, channelId, before, recipient.joined_at,
      recipient.id, recipient.id, recipient.id, actorId, limit + 1)
    const messages = rows.slice(0, limit).map(({ ephemeral, grantorId, grantRevision, deletionRevision, cryptoChannelId, ...box }) => ({
      ...box, ephemeral: JSON.parse(ephemeral), ...(cryptoChannelId ? { cryptoChannelId } : {}),
      ...(grantorId ? { grantorId, grantRevision } : {}),
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
      const used = storage.get().grants
      let granted = 0
      for (const entry of entries) {
        if (!grantable.get(channelId, entry.messageId, recipient.joined_at, actor.id, actor.id,
          recipient.id, recipient.id, actor.id, entry.deletionRevision)) {
          throw new RequestError(409, 'Mindestens eine Nachricht kann für dieses Mitglied nicht freigegeben werden.')
        }
        if (used + granted >= maxGrants && !existingGrant.get(entry.messageId, recipient.id)) throw full()
        granted += Number(add.run(entry.messageId, recipient.id, actor.id, entry.wrapper).changes)
      }
      completeJob.run(channelId, recipient.id)
      return { granted, alreadyShared: entries.length - granted }
    })
  }

  function rejectBatch(request, channelId, input) {
    if (!exactFields(input, ['recipientId', 'rejections']) || !Array.isArray(input.rejections) ||
        input.rejections.length < 1 || input.rejections.length > batchLimit) throw invalid()
    const ids = new Set()
    for (const entry of input.rejections) {
      if (!exactFields(entry, ['messageId', 'revision']) || typeof entry.messageId !== 'string' ||
          !idPattern.test(entry.messageId) || ids.has(entry.messageId) ||
          !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw invalid()
      ids.add(entry.messageId)
    }
    return transaction(db, () => {
      const actor = requireSession(request)
      if (input.recipientId !== actor.id) throw new RequestError(409, 'Das angemeldete Konto hat sich geändert.')
      const topicId = topicFor(actor.id, channelId)
      let rejected = 0
      for (const { messageId, revision } of input.rejections) {
        const grant = rejectable.get(channelId, messageId, actor.id, revision)
        if (!grant) continue
        if (storage.get().rejections >= maxRejections && !existingRejection.get(messageId, actor.id, grant.grantor_id)) throw full()
        rememberRejection.run(messageId, actor.id, grant.grantor_id, retryAfter)
        rejected += Number(removeRejected.run(revision).changes)
      }
      if (rejected) reopen.run(topicId, actor.id, channelId)
      return { rejected }
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
    const [, channelId, action] = match
    const actor = requireSession(request)
    topicFor(actor.id, channelId)
    if (request.method !== 'POST') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    const input = await readJson(request, 32768)
    const result = action === 'grants' ? createBatch(request, channelId, input) : rejectBatch(request, channelId, input)
    json(response, 200, result)
    return true
  }

  return { handle, requeueMovedHistory: ({ channelId, messageId }) => queueMoved.run(channelId, messageId) }
}
