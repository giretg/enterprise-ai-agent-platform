/**
 * Nem-LLM dispatcher worker — Postgres LISTEN/NOTIFY + cron safety net (§5.7).
 * Futtatás: npm run dispatcher:worker (app/)
 *
 * Kötelező: DIRECT_URL vagy DATABASE_URL (LISTEN-hez direct/pooler nélküli kapcsolat ajánlott).
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { Client } from 'pg'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { services } from '../src/domain'
import { DISPATCH_NOTIFY_CHANNEL } from '../src/lib/dispatch-notify'

const POLL_INTERVAL_MS = Number(process.env.DISPATCHER_POLL_INTERVAL_MS ?? 30_000)
const BATCH_LIMIT = Number(process.env.DISPATCHER_BATCH_LIMIT ?? 10)

let dispatchInFlight = false

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
  } catch (error) {
    console.error('[dispatcher] cycle error:', error instanceof Error ? error.message : error)
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

  await runDispatchCycle()

  const client = new Client({ connectionString })
  await client.connect()
  await client.query(`LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)
  console.log(`[dispatcher] LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)

  client.on('notification', (msg) => {
    const ticketId = msg.payload?.trim()
    if (!ticketId) return
    void runDispatchCycle(ticketId)
  })

  client.on('error', (error) => {
    console.error('[dispatcher] pg client error:', error.message)
  })

  setInterval(() => {
    void runDispatchCycle()
  }, POLL_INTERVAL_MS)

  process.on('SIGINT', async () => {
    console.log('[dispatcher] shutting down')
    await client.end()
    process.exit(0)
  })
}

main().catch((error) => {
  console.error('[dispatcher] fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
