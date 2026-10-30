import { createServer } from 'node:http'
import pg from 'pg'
import { createStorage } from './attachments.ts'
import { loadConfig } from './config.ts'
import { runStep, type EngineDeps, type TaskQueue } from './engine.ts'
import { createPgStore } from './pg-store.ts'
import { createPlatformClient } from './platform.ts'
import { cloudTasksQueue, inlineQueue } from './queue.ts'
import { createHandler } from './server.ts'

const IMAGE_INLINE_MAX = 5 * 1024 * 1024

const config = loadConfig()
// Kis pool: request-based Cloud Run, egy példányon kevés párhuzamos kérés; a Neon pooler mögött.
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 10_000 })
const storage = createStorage(config)
const deps: EngineDeps = {
  store: createPgStore(pool),
  platform: createPlatformClient(config.platformOrigin),
  queue: undefined as unknown as TaskQueue,
  limits: config.limits,
  platformOrigin: config.platformOrigin,
  coreTools: config.coreTools,
  loadImage: async (att) => (att.size <= IMAGE_INLINE_MAX ? `data:${att.mime};base64,${(await storage.get(att.storagePath)).toString('base64')}` : null),
}
deps.queue = config.queue.kind === 'inline' ? inlineQueue((task) => runStep(deps, task)) : cloudTasksQueue(config)

const server = createServer(createHandler({ ...deps, config, storage }))
// Az SSE-kérések legfeljebb ~2 percig élnek; a Cloud Run kérés-időkorlátja ennél nagyobb legyen.
server.requestTimeout = 0
server.listen(config.port, () => console.log(`platform-chat worker listening on :${config.port} (queue=${config.queue.kind})`))

const shutdown = () => {
  server.close()
  void pool.end()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
