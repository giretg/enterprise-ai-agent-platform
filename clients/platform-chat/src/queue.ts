/**
 * Lépés-sor (D11). Éles: Cloud Tasks HTTP-feladat a worker saját `/internal/step` végpontjára,
 * OIDC-tokennel. Fejlesztés/teszt: `inline` — ugyanabban a folyamatban, rövid újrapróbálással.
 * Cloud Tasks-hoz nincs SDK: a metadata-szerver tokenjével a REST API-t hívjuk.
 */
import type { Config } from './config.ts'
import type { TaskQueue } from './engine.ts'

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
let cachedToken: { value: string; until: number } | null = null

export async function metadataAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value
  const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } })
  if (!res.ok) throw new Error(`metadata token: ${res.status}`)
  const body = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 }
  return body.access_token
}

export function cloudTasksQueue(config: Config, fetchImpl: typeof fetch = fetch): TaskQueue {
  if (config.queue.kind !== 'cloud_tasks') throw new Error('cloud_tasks queue config required')
  const { project, location, queue, serviceAccountEmail } = config.queue
  const url = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${location}/queues/${queue}/tasks`
  return {
    async enqueue(task) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await metadataAccessToken(fetchImpl)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          task: {
            httpRequest: {
              httpMethod: 'POST',
              url: `${config.selfUrl}/internal/step`,
              headers: { 'content-type': 'application/json' },
              body: Buffer.from(JSON.stringify(task)).toString('base64'),
              oidcToken: { serviceAccountEmail, audience: config.selfUrl },
            },
          },
        }),
      })
      if (!res.ok) throw new Error(`cloud tasks enqueue: ${res.status} ${(await res.text()).slice(0, 200)}`)
    },
  }
}

/** Fejlesztéshez: a lépés a háttérben, ugyanebben a folyamatban fut (a válasz nem várja meg). */
export function inlineQueue(run: (task: { turnId: string; seq: number }) => Promise<'done' | 'skip' | 'retry'>): TaskQueue {
  const attempt = async (task: { turnId: string; seq: number }, n: number) => {
    try {
      const outcome = await run(task)
      if (outcome === 'retry' && n < 4) setTimeout(() => void attempt(task, n + 1), 500 * n)
    } catch (error) {
      console.error('platform-chat inline step failed', { ...task, attempt: n, error: String(error) })
      if (n < 4) setTimeout(() => void attempt(task, n + 1), 500 * n)
    }
  }
  return {
    async enqueue(task) {
      setImmediate(() => void attempt(task, 1))
    },
  }
}
