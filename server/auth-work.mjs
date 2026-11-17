import { RequestError } from './http.mjs'

const maxActive = 2
const createLane = limit => ({ limit, waiting: [], running: 0, clients: new Set(), subjects: new Set() })

function overload(response) {
  if (!response.destroyed) response.setHeader('Retry-After', '1')
  return new RequestError(503, 'Die Anmeldung ist gerade ausgelastet. Versuche es gleich erneut.')
}

export function createAuthWork({ waitMs = 2500 } = {}) {
  const login = createLane(8)
  const registration = createLane(4)
  const lanes = { login, registration }

  function startWaiting() {
    while (login.running + registration.running < maxActive) {
      // Share slots when both queues have work. A validated invite gets the next slot on a tie.
      const lane = registration.waiting.length && (registration.running <= login.running || !login.waiting.length)
        ? registration : login
      const next = lane.waiting.shift()
      if (!next) return
      lane.running++
      next.start()
    }
  }

  return async function runPasswordWork({ lane: laneName, ip, subject, response }, work) {
    if (response.destroyed) return
    const lane = lanes[laneName]
    if (lane.waiting.length >= lane.limit || lane.clients.has(ip) || lane.subjects.has(subject)) throw overload(response)
    lane.clients.add(ip)
    lane.subjects.add(subject)

    try {
      const started = await new Promise((resolve, reject) => {
        const remove = () => {
          const index = lane.waiting.indexOf(entry)
          if (index !== -1) lane.waiting.splice(index, 1)
          cleanup()
        }
        const cancel = () => {
          remove()
          resolve(false)
        }
        const timeout = setTimeout(() => {
          remove()
          reject(overload(response))
        }, waitMs)
        const cleanup = () => {
          clearTimeout(timeout)
          response.off('close', cancel)
        }
        const entry = { start() { cleanup(); resolve(true) } }
        lane.waiting.push(entry)
        response.once('close', cancel)
        startWaiting()
      })
      if (!started) return
      try {
        if (response.destroyed) return
        const result = await work()
        if (!response.destroyed) return result
      } finally {
        lane.running--
      }
    } finally {
      lane.clients.delete(ip)
      lane.subjects.delete(subject)
      startWaiting()
    }
  }
}
