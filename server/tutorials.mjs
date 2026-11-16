import { json, readJson, RequestError, transaction } from './http.mjs'

const chapters = ['home', 'join', 'room', 'chat', 'live', 'friends', 'direct', 'invites', 'help', 'profile']
const invalid = () => new RequestError(400, 'Ungültiger Rundgangsfortschritt.')

export function createTutorials(db, { requireSession }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tutorial_progress (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      completed TEXT NOT NULL CHECK (json_valid(completed) AND json_type(completed) = 'array')
    ) STRICT, WITHOUT ROWID;
  `)

  const get = db.prepare('SELECT generation, completed FROM tutorial_progress WHERE user_id = ?')
  const put = db.prepare(`INSERT INTO tutorial_progress(user_id, generation, completed) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET generation = excluded.generation, completed = excluded.completed
    WHERE tutorial_progress.generation <> excluded.generation OR tutorial_progress.completed <> excluded.completed`)

  function progress(userId) {
    const saved = get.get(userId)
    if (!saved) return { generation: 0, completed: [] }
    return { generation: saved.generation, completed: JSON.parse(saved.completed) }
  }

  async function handle(request, response, path) {
    if (path !== '/api/tutorials') return false
    const user = requireSession(request)
    if (request.method === 'GET') {
      json(response, 200, progress(user.id))
      return true
    }

    const reset = request.method === 'DELETE'
    if (!reset && request.method !== 'PATCH') {
      throw new RequestError(405, 'Diese Anfrage wird hier nicht unterstützt.')
    }

    const input = await readJson(request, 1024)
    const validGeneration = Number.isSafeInteger(input.generation) && input.generation >= 0
    const validCompletion = reset || Array.isArray(input.completed) && input.completed.length <= chapters.length &&
      input.completed.every(chapter => chapters.includes(chapter))
    if (!validGeneration || !validCompletion || Object.keys(input).length !== (reset ? 1 : 2)) throw invalid()

    const state = transaction(db, () => {
      if (requireSession(request).id !== user.id) throw new RequestError(409, 'Das angemeldete Konto hat sich geändert.')
      const current = progress(user.id)
      if (input.generation !== current.generation) {
        throw new RequestError(409, 'Der Rundgangsfortschritt wurde inzwischen zurückgesetzt.')
      }
      const next = reset ? { generation: current.generation + 1, completed: [] } : {
        generation: current.generation,
        completed: chapters.filter(chapter => current.completed.includes(chapter) || input.completed.includes(chapter)),
      }
      put.run(user.id, next.generation, JSON.stringify(next.completed))
      return next
    })
    json(response, 200, state)
    return true
  }

  return { handle }
}
