/**
 * CLI burok az ár-szinkronhoz. Alapból dry-run; íráshoz: --write
 *
 *   npx tsx scripts/sync-model-pricing.ts
 *   npx tsx scripts/sync-model-pricing.ts --write
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { syncModelPricing, type PriceSnapshotEntry } from '../src/domain/gateway/price-sync'
import { repositories } from '../src/repositories/postgres'

async function main() {
  const write = process.argv.includes('--write')
  const fixturePath = resolve(
    process.cwd(),
    'scripts/fixtures/model-pricing/litellm-price-snapshot.json',
  )

  let snapshot: PriceSnapshotEntry[] | null = null
  try {
    snapshot = JSON.parse(readFileSync(fixturePath, 'utf8')) as PriceSnapshotEntry[]
  } catch (e) {
    console.error('Pillanatkép nem olvasható:', e instanceof Error ? e.message : e)
    process.exit(1)
  }

  const result = await syncModelPricing({
    snapshot,
    settings: repositories.platformSettings,
    audit: write ? repositories.audit : undefined,
    dryRun: !write,
    sourceLabel: 'scripts/fixtures/model-pricing/litellm-price-snapshot.json',
    actorId: 'cli:sync-model-pricing',
  })

  console.log(JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    fingerprint: result.fingerprint,
    eurPerUsd: result.eurPerUsd,
    rateAsOf: result.rateAsOf,
    written: result.written,
    changed: result.diffs.filter((d) => d.changed).length,
    error: result.error,
    diffs: result.diffs,
  }, null, 2))

  if (!result.ok) process.exit(1)
}

void main()
