import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { json, readBytes, readJson, RequestError, transaction } from './http.mjs'

const idPattern = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const topicPath = new RegExp(`^/api/topics/(${idPattern})/appearance(?:/(cover|banner|background))?$`)
const imagePath = new RegExp(`^/api/appearance/images/(${idPattern})$`)
const imageLimit = 8 * 1024 * 1024
const outputLimit = 1024 * 1024
const collectionLimit = 256 * 1024 * 1024
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const imageSizes = {
  avatar: { width: 288, height: 288, fit: 'cover' },
  cover: { width: 960, height: 640, fit: 'inside' },
  banner: { width: 1680, height: 840, fit: 'inside' },
  background: { width: 1600, height: 1000, fit: 'inside' },
}
const defaults = {
  accentColor: null, surfaceColor: null, chatBackgroundMode: 'cover', chatBackgroundOpacity: 28,
}
const missing = () => new RequestError(404, 'Dieses Bild oder Thema ist nicht verfügbar.')
const forbidden = () => new RequestError(403, 'Du darfst dieses Design nicht ändern.')

sharp.cache(false)
sharp.concurrency(1)
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] })

function formatOf(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg'
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'png'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

async function toWebp(bytes, slot) {
  const format = formatOf(bytes)
  if (!format) throw new RequestError(415, 'Wähle ein JPEG-, PNG- oder WebP-Bild.')
  try {
    const decoder = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' })
    const info = await decoder.metadata()
    if (info.format !== format || !info.width || !info.height || info.width > 6000 || info.height > 6000 || (info.pages ?? 1) > 1) {
      throw new Error('Unsupported image')
    }
    const output = await decoder.autoOrient().resize({ ...imageSizes[slot], withoutEnlargement: true })
      .webp({ quality: 83, effort: 3 }).timeout({ seconds: 6 }).toBuffer()
    if (output.length > outputLimit) throw new Error('Output exceeds maximum')
    return output
  } catch {
    throw new RequestError(422, 'Das Bild konnte nicht verarbeitet werden. Wähle ein statisches Bild mit höchstens 16 Megapixeln.')
  }
}

function hexColor(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) throw new RequestError(400, 'Wähle eine gültige Farbe.')
  return value.toLowerCase()
}

function urlFor(id) {
  return id ? `/api/appearance/images/${id}` : null
}

export function createAppearance(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_appearance (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name_color TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topic_appearance (
      topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE, accent_color TEXT, surface_color TEXT,
      background_mode TEXT NOT NULL CHECK (background_mode IN ('cover', 'tile')),
      background_opacity INTEGER NOT NULL CHECK (background_opacity BETWEEN 0 AND 70)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS topic_designers (
      topic_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(topic_id, user_id),
      FOREIGN KEY(topic_id, user_id) REFERENCES topic_members(topic_id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS appearance_images (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE, slot TEXT NOT NULL, bytes BLOB NOT NULL,
      CHECK ((slot = 'avatar' AND user_id IS NOT NULL AND topic_id IS NULL) OR
        (slot IN ('cover', 'banner', 'background') AND topic_id IS NOT NULL AND user_id IS NULL)),
      UNIQUE(user_id, slot), UNIQUE(topic_id, slot)
    ) STRICT;
  `)

  const lookUpProfile = db.prepare('SELECT name_color FROM profile_appearance WHERE user_id = ?')
  const avatarFor = db.prepare("SELECT id FROM appearance_images WHERE user_id = ? AND slot = 'avatar'")
  const themeFor = db.prepare('SELECT * FROM topic_appearance WHERE topic_id = ?')
  const imagesFor = db.prepare('SELECT id, slot FROM appearance_images WHERE topic_id = ?')
  const grantExists = db.prepare('SELECT 1 FROM topic_designers WHERE topic_id = ? AND user_id = ?')
  // These statements are prepared on demand after community tables have been initialized.
  const uploads = new Set()
  const recentUploads = new Map()

  function profile(userId) {
    return { avatarUrl: urlFor(avatarFor.get(userId)?.id), nameColor: lookUpProfile.get(userId)?.name_color ?? null }
  }

  function topic(topicId, joined) {
    const style = themeFor.get(topicId)
    const urls = Object.fromEntries(imagesFor.all(topicId).map(({ slot, id }) => [slot, urlFor(id)]))
    return {
      coverUrl: urls.cover ?? null, bannerUrl: urls.banner ?? null,
      chatBackgroundUrl: joined ? urls.background ?? null : null,
      accentColor: style?.accent_color ?? defaults.accentColor,
      surfaceColor: style?.surface_color ?? defaults.surfaceColor,
      chatBackgroundMode: style?.background_mode ?? defaults.chatBackgroundMode,
      chatBackgroundOpacity: style?.background_opacity ?? defaults.chatBackgroundOpacity,
    }
  }

  function designPermission(topicId, userId, role, joined) {
    return Boolean(joined && (role === 'owner' || grantExists.get(topicId, userId)))
  }

  function manageTopic(topicId, userId) {
    const member = db.prepare('SELECT role, joined_at FROM topic_members WHERE topic_id = ? AND user_id = ?').get(topicId, userId)
    if (!designPermission(topicId, userId, member?.role, member?.joined_at)) throw forbidden()
  }

  function updateProfile(userId, input) {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'nameColor')) throw new RequestError(400, 'Ungültige Profileinstellung.')
    db.prepare(`INSERT INTO profile_appearance(user_id, name_color) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET name_color = excluded.name_color`).run(userId, hexColor(input.nameColor))
  }

  function updateTopic(topicId, input) {
    const current = topic(topicId, true)
    if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new RequestError(400, 'Ungültige Designeinstellung.')
    const accent = Object.hasOwn(input, 'accentColor') ? hexColor(input.accentColor) : current.accentColor
    const surface = Object.hasOwn(input, 'surfaceColor') ? hexColor(input.surfaceColor) : current.surfaceColor
    const mode = input.chatBackgroundMode === undefined ? current.chatBackgroundMode : input.chatBackgroundMode
    const opacity = input.chatBackgroundOpacity === undefined ? current.chatBackgroundOpacity : input.chatBackgroundOpacity
    if (!['cover', 'tile'].includes(mode) || !Number.isInteger(opacity) || opacity < 0 || opacity > 70) {
      throw new RequestError(400, 'Wähle eine gültige Hintergrund-Einstellung.')
    }
    db.prepare(`INSERT INTO topic_appearance(topic_id,accent_color,surface_color,background_mode,background_opacity)
      VALUES (?,?,?,?,?) ON CONFLICT(topic_id) DO UPDATE SET accent_color = excluded.accent_color,
      surface_color = excluded.surface_color, background_mode = excluded.background_mode,
      background_opacity = excluded.background_opacity`).run(topicId, accent, surface, mode, opacity)
  }

  function deleteImage(userId, topicId, slot) {
    const column = topicId ? 'topic_id' : 'user_id'
    db.prepare(`DELETE FROM appearance_images WHERE ${column} = ? AND slot = ?`).run(topicId ?? userId, slot)
  }

  function takeUploadSlot(userId) {
    if (uploads.size >= 2 || uploads.has(userId)) throw new RequestError(429, 'Bitte warte, bis der laufende Upload abgeschlossen ist.')
    const now = Date.now()
    for (const [id, entry] of recentUploads) if (entry.until <= now) recentUploads.delete(id)
    const entry = recentUploads.get(userId) ?? { until: now + 60000, count: 0 }
    if (entry.count >= 12) throw new RequestError(429, 'Warte kurz vor einem weiteren Bild-Upload.')
    entry.count++
    recentUploads.set(userId, entry)
    uploads.add(userId)
  }

  async function upload(request, userId, topicId, slot, verify) {
    if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, 'Wähle eine Bilddatei.')
    takeUploadSlot(userId)
    try {
      const image = await toWebp(await readBytes(request, imageLimit), slot)
      verify()
      transaction(db, () => {
        deleteImage(userId, topicId, slot)
        const used = db.prepare('SELECT coalesce(sum(length(bytes)),0) AS size FROM appearance_images').get().size
        if (used + image.length > collectionLimit) throw new RequestError(413, 'Der Speicher für Designbilder ist voll.')
        db.prepare('INSERT INTO appearance_images(id,user_id,topic_id,slot,bytes) VALUES (?,?,?,?,?)')
          .run(randomUUID(), topicId ? null : userId, topicId, slot, image)
      })
    } finally {
      uploads.delete(userId)
    }
  }

  function readImage(response, userId, imageId) {
    const asset = db.prepare('SELECT topic_id, slot FROM appearance_images WHERE id = ?').get(imageId)
    if (!asset) throw missing()
    if (asset.topic_id) {
      const audience = db.prepare(`SELECT t.visibility, m.joined_at, m.user_id FROM topics t LEFT JOIN topic_members m
        ON m.topic_id = t.id AND m.user_id = ? WHERE t.id = ?`).get(userId, asset.topic_id)
      if (!audience || (asset.slot === 'background' && !audience.joined_at) ||
          (audience.visibility === 'private' && !audience.user_id)) throw missing()
    }
    const { bytes } = db.prepare('SELECT bytes FROM appearance_images WHERE id = ?').get(imageId)
    response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': bytes.byteLength,
      'Cache-Control': 'private, no-store', 'Expires': '0' })
    response.end(bytes)
  }

  async function handle(request, response, path, requireSession) {
    const topicMatch = topicPath.exec(path)
    const imageMatch = imagePath.exec(path)
    const isProfile = path === '/api/profile' || path === '/api/profile/avatar'
    if (!topicMatch && !imageMatch && !isProfile) return false

    const user = requireSession(request)
    if (imageMatch) {
      if (request.method !== 'GET') throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
      readImage(response, user.id, imageMatch[1])
      return true
    }

    const topicId = topicMatch?.[1] ?? null
    const slot = topicId ? topicMatch[2] : path === '/api/profile/avatar' ? 'avatar' : undefined
    const verify = () => {
      if (requireSession(request).id !== user.id) throw forbidden()
      if (topicId) manageTopic(topicId, user.id)
    }
    verify()
    if (request.method === 'PATCH' && !slot) {
      const input = await readJson(request, 2048)
      verify()
      if (topicId) updateTopic(topicId, input)
      else updateProfile(user.id, input)
    } else if (request.method === 'PUT' && slot) {
      await upload(request, user.id, topicId, slot, verify)
    } else if (request.method === 'DELETE' && slot) {
      deleteImage(user.id, topicId, slot)
    } else if (request.method !== 'GET' || topicId || slot) {
      throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    }
    json(response, 200, topicId ? { appearance: topic(topicId, true) } : { profile: profile(user.id) })
    return true
  }

  return { handle, profile, topic, designPermission }
}
