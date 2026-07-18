/**
 * Ár-szinkron Seam 2 tesztek (#50 / #34)
 *
 * Futtatás: npx tsx scripts/model-pricing-sync.test.ts
 */

import assert from 'node:assert/strict'
import {
  convertSnapshotToPricingTable,
  mapSourceModelName,
  syncModelPricing,
  usdPerTokenToEurPerM,
  DEFAULT_EUR_PER_USD,
} from '../src/domain/gateway/price-sync'
import {
  MODEL_PRICING_SETTING_KEY,
  MODEL_PRICING_SYNCED_SETTING_KEY,
  MODEL_PRICING_SYNC_META_KEY,
  resolvePricingFromSettings,
} from '../src/lib/model-pricing'
import type { AuditLog } from '@prisma/client'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function makeSettings(initial: Record<string, unknown> = {}) {
  const store = { ...initial }
  return {
    store,
    async get(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null
    },
    async set(key: string, value: unknown) {
      store[key] = value
    },
  }
}

function makeAudit() {
  const events: AuditLog[] = []
  return {
    events,
    async append(data: Parameters<typeof events.push>[0] extends never ? never : Record<string, unknown>) {
      const row = {
        id: crypto.randomUUID(),
        seq: BigInt(events.length + 1),
        prevHash: 'prev',
        hash: 'hash',
        createdAt: new Date(),
        ...data,
      } as AuditLog
      events.push(row)
      return row
    },
  }
}

async function main() {
  console.log('=== Ár-szinkron tesztek (Seam 2) ===\n')

  await check('egységváltás: $ / token → € / 1M token + rögzített árfolyam', () => {
    // 0.000003 USD/token = $3 / 1M token; * 0.92 = 2.76 EUR / 1M
    assert.equal(usdPerTokenToEurPerM(0.000003, 0.92), 2.76)
    assert.equal(DEFAULT_EUR_PER_USD, 0.92)
  })

  await check('modellnév-leképezés előtag-illesztéssel', () => {
    assert.equal(mapSourceModelName('claude-3-5-sonnet-20241022'), 'claude-sonnet')
    assert.equal(mapSourceModelName('gpt-4o-mini'), 'gpt-4o')
    assert.equal(mapSourceModelName('totally-unknown-model'), null)
  })

  await check('dry-run: nem ír, csak diffet ad', async () => {
    const settings = makeSettings()
    const result = await syncModelPricing({
      snapshot: [
        { model: 'gpt-4o', inputCostPerToken: 0.0000025, outputCostPerToken: 0.00001 },
      ],
      settings,
      dryRun: true,
      eurPerUsd: 0.92,
      rateAsOf: '2026-01-15',
    })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.written, 0)
    assert.ok(result.diffs.length >= 1)
    const gpt = result.diffs.find((d) => d.model === 'gpt-4o')
    assert.ok(gpt, 'gpt-4o diff hiányzik')
    // Nincs synced réteg → before a beépített effektív ár, ne null
    assert.ok(gpt!.before, 'before ne legyen null, ha van beépített tarifa')
    assert.equal(gpt!.before!.inputPerMTokens, 2.3)
    assert.equal(settings.store[MODEL_PRICING_SYNCED_SETTING_KEY], undefined)
  })

  await check('írás: szinkronizált réteg frissül, kézi érintetlen; audit', async () => {
    const settings = makeSettings({
      [MODEL_PRICING_SETTING_KEY]: { 'gpt-4o': { inputPerMTokens: 99, outputPerMTokens: 99 } },
    })
    const audit = makeAudit()
    const result = await syncModelPricing({
      snapshot: [
        { model: 'gpt-4o', inputCostPerToken: 0.0000025, outputCostPerToken: 0.00001 },
      ],
      settings,
      audit,
      dryRun: false,
      eurPerUsd: 0.92,
      rateAsOf: '2026-01-15',
      actorId: 'ops-1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, false)
    assert.ok(result.written >= 1)
    assert.ok(settings.store[MODEL_PRICING_SYNCED_SETTING_KEY])
    assert.ok(settings.store[MODEL_PRICING_SYNC_META_KEY])
    // Kézi réteg érintetlen
    assert.deepEqual(settings.store[MODEL_PRICING_SETTING_KEY], {
      'gpt-4o': { inputPerMTokens: 99, outputPerMTokens: 99 },
    })
    // Effektív: kézi nyer
    const effective = resolvePricingFromSettings({
      manual: settings.store[MODEL_PRICING_SETTING_KEY],
      synced: settings.store[MODEL_PRICING_SYNCED_SETTING_KEY],
    })
    assert.equal(effective['gpt-4o']?.inputPerMTokens, 99)

    const syncEvt = audit.events.find((e) => e.action === 'model.pricing.sync')
    assert.ok(syncEvt, 'model.pricing.sync audit hiányzik')
    const meta = syncEvt?.metadata as { sourceFingerprint?: string; eurPerUsd?: number } | null
    assert.ok(meta?.sourceFingerprint)
    assert.equal(meta?.eurPerUsd, 0.92)
  })

  await check('hibás/hiányzó forrás: nincs throw, beépített alap érvényben', async () => {
    const settings = makeSettings()
    const empty = await syncModelPricing({ snapshot: null, settings, dryRun: false })
    assert.equal(empty.ok, false)
    assert.equal(empty.error, 'missing_or_empty_snapshot')
    assert.equal(settings.store[MODEL_PRICING_SYNCED_SETTING_KEY], undefined)

    const blank = await syncModelPricing({ snapshot: [], settings, dryRun: false })
    assert.equal(blank.ok, false)

    const table = convertSnapshotToPricingTable([
      { model: 'unknown-xyz', inputCostPerToken: 0.001, outputCostPerToken: 0.002 },
    ])
    assert.deepEqual(table, {})
  })

  console.log(`\n=== Összesítés ===`)
  if (failures === 0) {
    console.log('Minden teszt zöld (MIND OK)')
  } else {
    console.log(`${failures} teszt elbukott`)
    process.exit(1)
  }
}

void main()
