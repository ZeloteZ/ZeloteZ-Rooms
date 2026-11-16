import { json, readJson, RequestError, transaction } from './http.mjs'

const id = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const validId = new RegExp(`^${id}$`)
const ordering = new RegExp(`^/api/topics/(${id})/channels$`)
const removal = new RegExp(`^/api/channels/(${id})$`)
const missing = () => new RequestError(404, 'Thema oder Channel nicht gefunden.')

export const channelList = `SELECT id, title, type, stream_policy AS streamPolicy FROM channels
  WHERE topic_id = ? ORDER BY position, rowid`

export function initializeChannelOrder(db) {
  transaction(db, () => {
    if (!db.prepare('PRAGMA table_info(channels)').all().some(column => column.name === 'position')) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0);
        WITH existing AS MATERIALIZED (
          SELECT id, row_number() OVER (PARTITION BY topic_id ORDER BY rowid) AS number FROM channels
        )
        UPDATE channels SET position = (SELECT number FROM existing WHERE existing.id = channels.id);
      `)
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS channel_order ON channels(topic_id, position);
      CREATE INDEX IF NOT EXISTS channel_attachments ON attachments(channel_id);
      CREATE TRIGGER IF NOT EXISTS append_channel AFTER INSERT ON channels WHEN NEW.position = 0
      BEGIN
        UPDATE channels SET position = (
          SELECT max(position) + 1 FROM channels WHERE topic_id = NEW.topic_id
        ) WHERE id = NEW.id;
      END;
    `)
  })
}

export function createChannelManagement(db, { requireSession }) {
  const members = db.prepare('SELECT role FROM topic_members WHERE user_id = ? AND topic_id = ? AND joined_at IS NOT NULL')
  const getChannel = db.prepare('SELECT topic_id, type FROM channels WHERE id = ?')
  const channels = db.prepare(channelList)
  const setPosition = db.prepare('UPDATE channels SET position = ? WHERE id = ? AND topic_id = ?')
  const deleteAttachments = db.prepare('DELETE FROM attachments WHERE channel_id = ?')
  const deleteMessages = db.prepare('DELETE FROM messages WHERE channel_id = ?')
  const deleteChannel = db.prepare('DELETE FROM channels WHERE id = ?')

  function requireManager(request, topicId) {
    const actor = requireSession(request)
    const member = members.get(actor.id, topicId)
    if (!member) throw missing()
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new RequestError(403, 'Nur die Themenleitung kann Channels verwalten.')
    }
  }

  async function handle(request, response, { pathname }) {
    const order = request.method === 'PATCH' && ordering.exec(pathname)
    const remove = request.method === 'DELETE' && removal.exec(pathname)
    if (!order && !remove) return false

    if (order) {
      const [, topicId] = order
      requireManager(request, topicId)
      const { channelIds } = await readJson(request, 4096)
      if (!Array.isArray(channelIds) || channelIds.length > 50 ||
          channelIds.some(channelId => typeof channelId !== 'string' || !validId.test(channelId)) ||
          new Set(channelIds).size !== channelIds.length) {
        throw new RequestError(400, 'Ungültige Channel-Reihenfolge.')
      }
      const result = transaction(db, () => {
        requireManager(request, topicId)
        const current = new Set(channels.all(topicId).map(channel => channel.id))
        if (current.size !== channelIds.length || channelIds.some(channelId => !current.has(channelId))) {
          throw new RequestError(409, 'Die Channel-Liste hat sich geändert. Lade sie erneut.')
        }
        channelIds.forEach((channelId, index) => setPosition.run(index + 1, channelId, topicId))
        return channels.all(topicId)
      })
      json(response, 200, { channels: result })
    } else {
      const [, channelId] = remove
      transaction(db, () => {
        const channel = getChannel.get(channelId)
        if (!channel) throw missing()
        requireManager(request, channel.topic_id)
        if (channel.type === 'live') {
          // The stream sweeper uses publisher IDs on ended broadcasts to disconnect MediaMTX.
          db.prepare('UPDATE broadcasts SET ended_at = ? WHERE channel_id = ? AND ended_at IS NULL')
            .run(Date.now(), channelId)
        }
        deleteAttachments.run(channelId)
        deleteMessages.run(channelId)
        deleteChannel.run(channelId)
      })
      response.writeHead(204).end()
    }
    return true
  }

  return { handle }
}
