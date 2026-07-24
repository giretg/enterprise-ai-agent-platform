/**
 * Nem-LLM dispatcher worker — Postgres LISTEN/NOTIFY + cron safety net (§5.7).
 * Futtatás: npm run dispatcher:worker (app/)
 *
 * Kötelező: DIRECT_URL vagy DATABASE_URL (LISTEN-hez direct/pooler nélküli kapcsolat ajánlott).
 *
 * Cloud Run service-ként (production, min-instances ≥ 1) a konténernek a $PORT-ra
 * kell figyelnie, különben a platform unhealthy-nek jelöli — ezért egy minimális
 * health-szerver fut a worker mellett (lásd startHealthServer).
 *
 * DISPATCHER_RUN_FOR_MS (opcionális): ha be van állítva, a worker ennyi ms után
 * magától leáll (lezárja a LISTEN-kapcsolatot, kilép) — így lokális teszteléshez
 * NEM kell örökké futó process, csak amíg tényleg kell (§5.7 költség-kiegészítés).
 * Pl.: DISPATCHER_RUN_FOR_MS=120000 npm run dispatcher:worker
 */
import './load-env'
import { createServer } from 'http'
import { Client } from 'pg'

import { services } from '../src/domain'
import { ensureActiveDatabaseMode } from '../src/lib/db'
import { getActiveDatabaseMode } from '../src/lib/database-mode'
import { DISPATCH_NOTIFY_CHANNEL } from '../src/lib/dispatch-notify'
import { CHANNEL_TURN_NOTIFY_CHANNEL } from '../src/lib/channel-notify'
import { runDispatchCycle as runSharedDispatchCycle } from '../src/domain/dispatcher/run-dispatch-cycle'

const POLL_INTERVAL_MS = Number(process.env.DISPATCHER_POLL_INTERVAL_MS ?? 30_000)
const BATCH_LIMIT = Number(process.env.DISPATCHER_BATCH_LIMIT ?? 10)
const RUN_FOR_MS = Number(process.env.DISPATCHER_RUN_FOR_MS ?? 0)

const health = {
  startedAt: new Date().toISOString(),
  lastCycleAt: null as string | null,
  lastCycleError: null as string | null,
  listening: false,
  cycles: 0,
}

// A tényleges leállítás (main()-ben definiálva, a pg client lezárásával) csak a
// LISTEN-kapcsolat felállása után elérhető — a health-szerver ezen a referencián
// keresztül hívja meg, admin UI-ból érkező /control/stop kérésre.
let triggerShutdown: ((signal: string) => Promise<void>) | null = null

/**
 * Minimális HTTP health-szerver a Cloud Run service liveness/startup próbájához,
 * plusz egy admin-vezérelt leállító végpont (§ admin UI worker-panel).
 * A worker maga eseményvezérelt (LISTEN/NOTIFY + cron), nincs bejövő forgalma;
 * a 200-as válasz csak azt jelzi, hogy a process él és a LISTEN kapcsolat áll.
 */
function startHealthServer() {
  const port = Number(process.env.PORT ?? 8080)
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/control/stop') {
      const expectedToken = process.env.DISPATCHER_CONTROL_TOKEN?.trim()
      const providedToken = req.headers['x-dispatcher-token']
      if (!expectedToken || providedToken !== expectedToken) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid or missing x-dispatcher-token' }))
        return
      }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'stopping' }))
      void triggerShutdown?.('http-control')
      return
    }

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
  try {
    const summary = await runSharedDispatchCycle({ ticketId, batchLimit: BATCH_LIMIT, triggeredBy: 'worker' })
    if (summary.skipped) return

    if (summary.reclaimedDispatches > 0) {
      console.log(`[dispatcher] reclaimed ${summary.reclaimedDispatches} stale in_progress ticket(s)`)
    }
    if (summary.reclaimedScheduledTasks > 0) {
      console.log(
        `[dispatcher] reclaimed ${summary.reclaimedScheduledTasks} stale materializing scheduled task(s)`,
      )
    }
    if (summary.reclaimedAgentTurns > 0) {
      console.log(
        `[dispatcher] watchdog closed ${summary.reclaimedAgentTurns} stale agent turn(s)`,
      )
    }
    if (summary.channelTurns.reclaimed > 0) {
      console.log(`[dispatcher] reclaimed ${summary.channelTurns.reclaimed} stale channel turn(s)`)
    }
    if (summary.channelTurns.processed > 0) {
      console.log(`[dispatcher] processed ${summary.channelTurns.processed} channel turn(s)`)
    }
    if (summary.materializedScheduledTasks > 0) {
      console.log(`[dispatcher] materialized ${summary.materializedScheduledTasks} scheduled task(s)`)
    }
    if (summary.monitorSweep.ran && summary.monitorSweep.escalated > 0) {
      console.log(
        `[dispatcher] monitor: ${summary.monitorSweep.escalated} escalated sweep(s), ${summary.monitorSweep.openedTickets} ticket(s) opened`,
      )
    }
    if (summary.workspacePurge.purgedTickets > 0) {
      console.log(
        `[dispatcher] purged ${summary.workspacePurge.purgedTickets} expired workspace(s), ${summary.workspacePurge.deletedObjects} object(s)`,
      )
    }

    if (ticketId) {
      console.log(`[dispatcher] ticket ${ticketId.slice(0, 8)}… → ${summary.dispatch.ticketStatus}`)
    } else if (summary.dispatch.started > 0 || summary.dispatch.budgetBlocked > 0) {
      console.log(
        `[dispatcher] batch: ${summary.dispatch.scanned} scanned, ${summary.dispatch.started} started, ${summary.dispatch.budgetBlocked} budget_blocked`,
      )
    }
    health.lastCycleAt = new Date().toISOString()
    health.lastCycleError = null
    health.cycles += 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    health.lastCycleError = message
    console.error('[dispatcher] cycle error:', message)
  }
}

async function main() {
  await ensureActiveDatabaseMode()
  const mode = getActiveDatabaseMode()
  const connectionString =
    mode === 'test'
      ? (process.env.DIRECT_URL_TEST ?? process.env.DATABASE_URL_TEST)
      : (process.env.DIRECT_URL ?? process.env.DATABASE_URL)
  if (!connectionString) {
    throw new Error(
      mode === 'test'
        ? 'Missing DIRECT_URL_TEST or DATABASE_URL_TEST for dispatcher worker (test mode)'
        : 'Missing DIRECT_URL or DATABASE_URL for dispatcher worker',
    )
  }

  console.log(`[dispatcher] starting worker (db=${mode}, poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_LIMIT})`)

  // A health-szervert azonnal elindítjuk, hogy a Cloud Run startup-probe
  // ne timeoutoljon az első (DB-t igénylő) ciklus alatt.
  startHealthServer()

  await runDispatchCycle()

  const client = new Client({ connectionString })
  await client.connect()
  await client.query(`LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)
  // A worker MÁSODIK munkatípusa (#73, D8): a bekötött Telegram-üzenetek forduló-sora. Külön
  // NOTIFY-csatorna, hogy a chat-forgalom azonnal ébressze a workert, ne a cron-hálót várja.
  await client.query(`LISTEN ${CHANNEL_TURN_NOTIFY_CHANNEL}`)
  health.listening = true
  console.log(`[dispatcher] LISTEN ${DISPATCH_NOTIFY_CHANNEL}, ${CHANNEL_TURN_NOTIFY_CHANNEL}`)

  client.on('notification', (msg) => {
    // Csatorna-forduló ébresztő: a payload a turnId, de a feldolgozás a soron megy (nem
    // turnId-alapú), ezért egy sima ciklust indítunk, ami lezavarja a queued fordulókat.
    if (msg.channel === CHANNEL_TURN_NOTIFY_CHANNEL) {
      void runDispatchCycle()
      return
    }
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
  let lastDbMode: ReturnType<typeof getActiveDatabaseMode> | null = null
  const scheduleNext = async () => {
    let intervalMs = POLL_INTERVAL_MS
    try {
      await ensureActiveDatabaseMode()
      const dbMode = getActiveDatabaseMode()
      if (dbMode !== lastDbMode) {
        console.log(`[dispatcher] database mode: ${dbMode}`)
        lastDbMode = dbMode
      }
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
  triggerShutdown = shutdown
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // Határidős futtatás (§5.7 költség-kiegészítés): ha be van állítva, a worker nem
  // fut örökké — ennyi ms után lezárja a LISTEN-kapcsolatot és kilép. Így lokálisan
  // csak addig terheli a Neon-t, amíg tényleg tesztelsz, nem "eszméletlenül" örökké.
  if (RUN_FOR_MS > 0) {
    console.log(`[dispatcher] DISPATCHER_RUN_FOR_MS beállítva — ${RUN_FOR_MS}ms után magától leáll`)
    setTimeout(() => void shutdown('timebox'), RUN_FOR_MS)
  }
}

main().catch((error) => {
  console.error('[dispatcher] fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
