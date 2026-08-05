/**
 * Ár-szinkron Seam 2 tesztek (#50 / #34)
 *
 * Futtatás: npx tsx scripts/model-pricing-sync.test.ts
 */

import assert from 'node:assert/strict'
import {
  convertSnapshotToPricingTable,
  fetchOpenRouterPriceSnapshot,
  getRepoPriceSnapshot,
  mapSourceModelName,
  openRouterLocalModelAliases,
  OPENROUTER_PRICE_SOURCE_LABEL,
  REPO_PRICE_SNAPSHOT_LABEL,
  syncModelPricing,
  usdPerTokenToEurPerM,
  DEFAULT_EUR_PER_USD,
} from '../src/domain/gateway/price-sync'
import {
  MODEL_PRICING_SETTING_KEY,
  MODEL_PRICING_SYNCED_SETTING_KEY,
  MODEL_PRICING_SYNC_META_KEY,
  resolvePricingFromSettings,
  buildModelPricingViewRows,
  DEFAULT_MODEL_PRICING,
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

  await check('repo-pillanatkép beágyazva (offline CLI forrás)', async () => {
    const snapshot = getRepoPriceSnapshot()
    assert.ok(Array.isArray(snapshot) && snapshot.length > 0)
    assert.ok(REPO_PRICE_SNAPSHOT_LABEL.includes('litellm-price-snapshot'))
    const settings = makeSettings()
    const result = await syncModelPricing({
      snapshot,
      settings,
      dryRun: false,
      sourceLabel: REPO_PRICE_SNAPSHOT_LABEL,
      actorId: 'cli:test',
    })
    assert.equal(result.ok, true)
    assert.ok(result.written >= 1)
    assert.ok(settings.store[MODEL_PRICING_SYNCED_SETTING_KEY])
  })

  await check('OpenRouter fetch → keepSourceIds sync (0$ = ingyenes)', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'deepseek/deepseek-r1:free',
              pricing: { prompt: '0', completion: '0' },
            },
            {
              id: 'deepseek/deepseek-v4-flash-0731',
              pricing: { prompt: '0.00000009', completion: '0.00000018' },
            },
            {
              id: 'ignored/no-pricing',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    const snapshot = await fetchOpenRouterPriceSnapshot({ fetchImpl, baseUrl: 'https://openrouter.ai/api/v1' })
    assert.equal(snapshot.length, 2)
    assert.equal(snapshot[0]!.inputCostPerToken, 0)

    const table = convertSnapshotToPricingTable(snapshot, {
      keepSourceIds: true,
      eurPerUsd: 0.92,
    })
    assert.equal(table['deepseek/deepseek-r1:free']?.inputPerMTokens, 0)
    assert.equal(table['deepseek/deepseek-r1:free']?.outputPerMTokens, 0)
    // 0.00000009 * 1e6 * 0.92 = 0.0828
    assert.equal(table['deepseek/deepseek-v4-flash-0731']?.inputPerMTokens, 0.0828)
    assert.equal(table['deepseek/deepseek-v4-flash-0731']?.outputPerMTokens, 0.1656)

    const settings = makeSettings()
    const result = await syncModelPricing({
      snapshot,
      settings,
      dryRun: false,
      keepSourceIds: true,
      sourceLabel: OPENROUTER_PRICE_SOURCE_LABEL,
      eurPerUsd: 0.92,
      actorId: 'ui:test',
    })
    assert.equal(result.ok, true)
    assert.equal(result.written, 2)
    assert.equal(
      (settings.store[MODEL_PRICING_SYNCED_SETTING_KEY] as Record<string, { inputPerMTokens: number }>)[
        'deepseek/deepseek-v4-flash-0731'
      ]?.inputPerMTokens,
      0.0828,
    )
  })

  await check('OpenRouter HTTP hiba → throw', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 })
    await assert.rejects(
      () => fetchOpenRouterPriceSnapshot({ fetchImpl }),
      (e: unknown) => e instanceof Error && e.message === 'openrouter_models_http_503',
    )
  })

  await check('OpenRouter google/gemini-… → gemini-… alias (közvetlen Gemini provider)', () => {
    assert.deepEqual(openRouterLocalModelAliases('google/gemini-2.5-flash'), ['gemini-2.5-flash'])
    assert.deepEqual(openRouterLocalModelAliases('~google/gemini-3.5-flash'), ['gemini-3.5-flash'])
    assert.deepEqual(openRouterLocalModelAliases('deepseek/deepseek-v4-flash-0731'), [])
    assert.deepEqual(openRouterLocalModelAliases('google/gemma-3-27b'), [])

    const table = convertSnapshotToPricingTable(
      [
        {
          model: 'google/gemini-2.5-flash',
          inputCostPerToken: 0.0000003,
          outputCostPerToken: 0.0000025,
        },
      ],
      { keepSourceIds: true, eurPerUsd: 0.92 },
    )
    // $0.30 / $2.50 per 1M → €0.276 / €2.3
    assert.equal(table['google/gemini-2.5-flash']?.inputPerMTokens, 0.276)
    assert.equal(table['gemini-2.5-flash']?.inputPerMTokens, 0.276)
    assert.equal(table['gemini-2.5-flash']?.outputPerMTokens, 2.3)
  })

  await check('OpenRouter anthropic/claude-… → claude-… alias (családkulcsok)', () => {
    assert.deepEqual(openRouterLocalModelAliases('anthropic/claude-haiku-4.5').sort(), [
      'claude-haiku',
      'claude-haiku-4-5',
    ])
    assert.deepEqual(openRouterLocalModelAliases('anthropic/claude-sonnet-5').sort(), [
      'claude-sonnet',
      'claude-sonnet-5',
    ])
    assert.deepEqual(openRouterLocalModelAliases('anthropic/claude-opus-4.8').sort(), [
      'claude-opus',
      'claude-opus-4-8',
    ])
    assert.deepEqual(openRouterLocalModelAliases('~anthropic/claude-sonnet-latest').sort(), [
      'claude-sonnet',
      'claude-sonnet-5',
      'claude-sonnet-latest',
    ])
    // Régi verzió: csak saját normalizált id, ne írja felül a család aktuális árát
    assert.deepEqual(openRouterLocalModelAliases('anthropic/claude-sonnet-4.5'), ['claude-sonnet-4-5'])

    const table = convertSnapshotToPricingTable(
      [
        {
          model: 'anthropic/claude-sonnet-4.5',
          inputCostPerToken: 0.000003,
          outputCostPerToken: 0.000015,
        },
        {
          model: 'anthropic/claude-sonnet-5',
          inputCostPerToken: 0.000002,
          outputCostPerToken: 0.00001,
        },
      ],
      { keepSourceIds: true, eurPerUsd: 0.92 },
    )
    // $2 / $10 → €1.84 / €9.2 — a család a sonnet-5 árat kapja, nem a 4.5-ét
    assert.equal(table['claude-sonnet-5']?.inputPerMTokens, 1.84)
    assert.equal(table['claude-sonnet']?.inputPerMTokens, 1.84)
    assert.equal(table['claude-sonnet-4-5']?.inputPerMTokens, 2.76)
  })

  await check('árazási view: engedélyezett modellek is megjelennek (örökölt árral)', () => {
    const rows = buildModelPricingViewRows({
      effective: {
        ...DEFAULT_MODEL_PRICING,
        'x-ai/grok-4.5': { inputPerMTokens: 1, outputPerMTokens: 2 },
        'openrouter/only-in-synced-catalog': { inputPerMTokens: 0.1, outputPerMTokens: 0.2 },
      },
      layers: {
        builtin: DEFAULT_MODEL_PRICING,
        synced: {
          'openrouter/only-in-synced-catalog': { inputPerMTokens: 0.1, outputPerMTokens: 0.2 },
        },
        manual: { 'x-ai/grok-4.5': { inputPerMTokens: 1, outputPerMTokens: 2 } },
      },
      syncMeta: null,
      configuredModels: ['gemini-3.5-flash', 'x-ai/grok-4.5'],
    })
    const gemini = rows.find((r) => r.model === 'gemini-3.5-flash')
    assert.ok(gemini)
    assert.equal(gemini.configured, true)
    assert.equal(gemini.resolvedFrom, 'default')
    const grok = rows.find((r) => r.model === 'x-ai/grok-4.5')
    assert.ok(grok)
    assert.equal(grok.source, 'manual')
    assert.equal(grok.resolvedFrom, null)
    assert.equal(rows.some((r) => r.model === 'default'), false)
    // A teljes OpenRouter katalógus ne duzzassza a listát.
    assert.equal(rows.some((r) => r.model === 'openrouter/only-in-synced-catalog'), false)
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
