/**
 * Nem-LLM dispatcher worker — Postgres LISTEN/NOTIFY + cron safety net (§5.7).
 * Futtatás: npm run dispatcher:worker (app/)
 *
 * Kötelező: DIRECT_URL vagy DATABASE_URL (LISTEN-hez direct/pooler nélküli kapcsolat ajánlott).
 *
 * Cloud Run service-ként (production, min-instances ≥ 1) a konténernek a $PORT-ra
 * kell figyelnie, különben a platform unhealthy-nek jelöli — ezért egy minimális
 * health-szerver fut a worker mellett (lásd startHealthServer).
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { createServer } from 'http'
import { Client } from 'pg'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { services } from '../src/domain'
import { DISPATCH_NOTIFY_CHANNEL } from '../src/lib/dispatch-notify'

const POLL_INTERVAL_MS = Number(process.env.DISPATCHER_POLL_INTERVAL_MS ?? 30_000)
const BATCH_LIMIT = Number(process.env.DISPATCHER_BATCH_LIMIT ?? 10)

let dispatchInFlight = false

const health = {
  startedAt: new Date().toISOString(),
  lastCycleAt: null as string | null,
  lastCycleError: null as string | null,
  listening: false,
  cycles: 0,
}

/**
 * Minimális HTTP health-szerver a Cloud Run service liveness/startup próbájához.
 * A worker maga eseményvezérelt (LISTEN/NOTIFY + cron), nincs bejövő forgalma;
 * a 200-as válasz csak azt jelzi, hogy a process él és a LISTEN kapcsolat áll.
 */
function startHealthServer() {
  const port = Number(process.env.PORT ?? 8080)
  const server = createServer((req, res) => {
    const healthy = health.listening
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting', ...health }))
  })
  server.listen(port, () => {
    console.log(`[dispatcher] health server listening on :${port}`)
  })
  return server
}

async function runDispatchCycle(ticketId?: string) {
  if (dispatchInFlight) return
  dispatchInFlight = true
  try {
    const reclaimed = await services.dispatcher.reclaimStaleDispatches()
    if (reclaimed.some((r) => r.status === 'reclaimed')) {
      console.log(
        `[dispatcher] reclaimed ${reclaimed.filter((r) => r.status === 'reclaimed').length} stale in_progress ticket(s)`,
      )
    }

    const reclaimedTasks = await services.scheduledTasks.reclaimStaleMaterializations()
    if (reclaimedTasks.some((r) => r.status === 'reclaimed')) {
      console.log(
        `[dispatcher] reclaimed ${reclaimedTasks.filter((r) => r.status === 'reclaimed').length} stale materializing scheduled task(s)`,
      )
    }

    const materialized = await services.scheduledTasks.materializeDue(new Date(), BATCH_LIMIT)
    const materializedCount = materialized.filter((r) => r.status === 'materialized').length
    if (materializedCount > 0) {
      console.log(`[dispatcher] materialized ${materializedCount} scheduled task(s)`)
    }

    const workspacePurge = await services.workspaceLifecycle.purgeExpiredWorkspaces(BATCH_LIMIT)
    if (workspacePurge.purgedTickets > 0) {
      console.log(
        `[dispatcher] purged ${workspacePurge.purgedTickets} expired workspace(s), ${workspacePurge.deletedObjects} object(s)`,
      )
    }

    if (ticketId) {
      const result = await services.dispatcher.dispatchTicket(ticketId)
      console.log(`[dispatcher] ticket ${ticketId.slice(0, 8)}… → ${result.status}`)
      return
    }

    const results = await services.dispatcher.dispatchReadyBatch(BATCH_LIMIT)
    const started = results.filter((r) => r.status === 'started').length
    if (started > 0 || results.some((r) => r.status === 'budget_blocked')) {
      console.log(
        `[dispatcher] batch: ${results.length} scanned, ${started} started, ${results.filter((r) => r.status === 'budget_blocked').length} budget_blocked`,
      )
    }
    health.lastCycleAt = new Date().toISOString()
    health.lastCycleError = null
    health.cycles += 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    health.lastCycleError = message
    console.error('[dispatcher] cycle error:', message)
  } finally {
    dispatchInFlight = false
  }
}

async function main() {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('Missing DIRECT_URL or DATABASE_URL for dispatcher worker')
  }

  console.log(`[dispatcher] starting worker (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_LIMIT})`)

  // A health-szervert azonnal elindítjuk, hogy a Cloud Run startup-probe
  // ne timeoutoljon az első (DB-t igénylő) ciklus alatt.
  startHealthServer()

  await runDispatchCycle()

  const client = new Client({ connectionString })
  await client.connect()
  await client.query(`LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)
  health.listening = true
  console.log(`[dispatcher] LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)

  client.on('notification', (msg) => {
    const ticketId = msg.payload?.trim()
    if (!ticketId) return
    void runDispatchCycle(ticketId)
  })

  client.on('error', (error) => {
    health.listening = false
    console.error('[dispatcher] pg client error:', error.message)
  })

  // Cron safety net: self-rescheduling loop, ami minden körben friss intervallumot és
  // kill-switch állapotot olvas a DB-ből (admin felület → újra-deploy nélkül hat).
  let lastEnabled: boolean | null = null
  const scheduleNext = async () => {
    let intervalMs = POLL_INTERVAL_MS
    try {
      const controls = await services.platformSettings.getDispatcherControls()
      intervalMs = controls.pollIntervalMs
      if (controls.enabled !== lastEnabled) {
        console.log(`[dispatcher] dispatch ${controls.enabled ? 'ENABLED' : 'PAUSED (admin)'}`)
        lastEnabled = controls.enabled
      }
    } catch (error) {
      console.error('[dispatcher] controls read error:', error instanceof Error ? error.message : error)
    }
    setTimeout(() => {
      void runDispatchCycle().finally(() => void scheduleNext())
    }, intervalMs)
  }
  void scheduleNext()

  const shutdown = async (signal: string) => {
    console.log(`[dispatcher] shutting down (${signal})`)
    health.listening = false
    await client.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[dispatcher] fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
