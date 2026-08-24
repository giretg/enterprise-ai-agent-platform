/**
 * Privacy-katalógus szinkron (issue #320, forrás-szerződés §6.1).
 *
 * DoD: a mezőjelölés a forrás `GET /privacy/catalog` válaszából kerül a
 * connector-configba; érvénytelen katalógus fail-closed (a régi jelölés marad);
 * a változás auditálva van, és a futásidő ugyanazt látja.
 *
 * Futtatás: npm run test:privacy-catalog-sync
 */
import assert from 'node:assert/strict'

import {
  applyPrivacyCatalogToConfig,
  describePrivacyCatalogChanges,
  fetchConnectorPrivacyCatalog,
  syncConnectorPrivacyCatalog,
  type PrivacyCatalogFetcher,
} from '../src/domain/privacy/privacy-catalog-sync'
import { syncPrivacyCatalogForConnectorRow } from '../src/domain/privacy/privacy-catalog-sync-service'
import {
  inspectConnectorPrivacyFields,
  parsePrivacyCatalogV2,
  readConnectorEntityTypes,
  readConnectorUnlistedDefault,
  type PrivacyCatalogV2,
} from '../src/domain/privacy/connector-privacy'
import { effectiveConnectorRuntimeConfig } from '../src/domain/connector-template/ostorosbor-config-enrichment'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'
import type { AuditRepository } from '../src/repositories/interfaces'
import type { AuditLog } from '@prisma/client'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'

const STORED_CONFIG = {
  provider: 'ingatlan-crm',
  baseUrl: 'https://crm.example/api/connector/v1',
  egressHosts: ['crm.example'],
  authMode: 'service',
  auth: { type: 'bearer_token' },
  scopesSuggested: [],
  proposedTools: [{ name: 'list', method: 'GET', path: '/accounts', access: 'read' }],
  privacy: {
    structured_field_privacy: true,
    stable_entity_ids: true,
    entity_resolution: false,
    free_text_hints: false,
    resolve_path: '/privacy/resolve',
  },
  fields: {
    id: { type: 'integer', privacy: 'pass' },
    company_name: {
      type: 'string',
      privacy: 'tokenize',
      entity_type: 'company',
      source_id: 'crm/company/{id}',
    },
  },
}

/** A forrás friss katalógusa: új, forrás-egyedi típus + jelöletlen mezők tiltása. */
const SOURCE_CATALOG: PrivacyCatalogV2 = {
  catalog_version: 7,
  system: 'crm',
  entity_types: {
    company: { label: 'Cég', reversible: true },
    ingatlan: { label: 'Ingatlan', reversible: true },
  },
  unlisted_default: 'block',
  privacy: {
    structured_field_privacy: true,
    stable_entity_ids: true,
    entity_resolution: true,
    free_text_hints: false,
  },
  fields: {
    id: { type: 'integer', privacy: 'pass' },
    company_name: {
      type: 'string',
      privacy: 'tokenize',
      entity_type: 'company',
      source_id: 'crm/company/{id}',
    },
    hrsz: {
      type: 'string',
      privacy: 'tokenize',
      entity_type: 'ingatlan',
      source_id: 'crm/ingatlan/{id}',
    },
    revenue: { type: 'number', privacy: 'pass' },
  },
}

function fetcherFor(body: unknown): PrivacyCatalogFetcher {
  return async () => {
    const catalog = parsePrivacyCatalogV2(body)
    return catalog
      ? { ok: true, catalog }
      : { ok: false, reason: 'invalid_catalog', detail: 'séma-hiba' }
  }
}

function recordingAudit(): { repo: AuditRepository; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  const repo = {
    async append(data: Record<string, unknown>) {
      if (!REGISTERED_AUDIT_ACTIONS.has(String(data.action))) {
        throw new Error(`nem regisztrált audit action: ${data.action}`)
      }
      events.push(data)
      return {} as AuditLog
    },
    async findMany() { return [] },
    async findAll() { return [] },
    async getActionCounts() { return {} },
  } as unknown as AuditRepository
  return { repo, events }
}

async function main() {
  console.log('privacy-katalógus szinkron (#320)')

  await test('a forrás katalógusa a connector-configba kerül, és a futásidő is azt látja', () => {
    const outcome = applyPrivacyCatalogToConfig(STORED_CONFIG, SOURCE_CATALOG)
    assert.equal(outcome.status, 'applied')
    if (outcome.status !== 'applied') return
    assert.equal(outcome.catalogVersion, 7)

    const runtime = effectiveConnectorRuntimeConfig(outcome.config)
    const inspected = inspectConnectorPrivacyFields(runtime)
    assert.equal(inspected.status, 'valid')
    if (inspected.status !== 'valid') return
    assert.equal(inspected.fields.hrsz?.entity_type, 'ingatlan')
    assert.equal(inspected.fields.revenue?.privacy, 'pass')
    assert.equal(readConnectorEntityTypes(runtime).ingatlan?.label, 'Ingatlan')
    assert.equal(readConnectorUnlistedDefault(runtime), 'block')
  })

  await test('a platform-oldali privacy-extrák (resolve_path) megmaradnak a capability felülírásakor', () => {
    const outcome = applyPrivacyCatalogToConfig(STORED_CONFIG, SOURCE_CATALOG)
    assert.equal(outcome.status, 'applied')
    if (outcome.status !== 'applied') return
    const privacy = outcome.config.privacy as Record<string, unknown>
    assert.equal(privacy.resolve_path, '/privacy/resolve')
    assert.equal(privacy.entity_resolution, true)
  })

  await test('a változáslista emberi nyelven mondja meg, mi mozdult', () => {
    const outcome = applyPrivacyCatalogToConfig(STORED_CONFIG, SOURCE_CATALOG)
    assert.equal(outcome.status, 'applied')
    if (outcome.status !== 'applied') return
    const joined = outcome.changes.join('\n')
    assert.match(joined, /mező hozzáadva: hrsz → tokenize\/ingatlan/)
    assert.match(joined, /entitástípus hozzáadva: ingatlan/)
    assert.match(joined, /jelöletlen mezők: pass → block/)
    assert.match(joined, /katalógusverzió: ‹nincs› → 7/)
  })

  await test('változatlan katalógus → nincs írás, nincs audit', async () => {
    const applied = applyPrivacyCatalogToConfig(STORED_CONFIG, SOURCE_CATALOG)
    assert.equal(applied.status, 'applied')
    if (applied.status !== 'applied') return
    const second = applyPrivacyCatalogToConfig(applied.config, SOURCE_CATALOG)
    assert.equal(second.status, 'no_change')
    assert.deepEqual(describePrivacyCatalogChanges(applied.config, applied.config), [])

    const audit = recordingAudit()
    let persisted = 0
    const outcome = await syncPrivacyCatalogForConnectorRow(
      { id: CONNECTOR, name: 'CRM', type: 'http_api', tenantId: TENANT, secretAlias: null, config: applied.config },
      { id: null },
      {
        audit: audit.repo,
        fetchCatalog: fetcherFor(SOURCE_CATALOG),
        persist: async () => { persisted += 1 },
      },
    )
    assert.equal(outcome.status, 'no_change')
    assert.equal(persisted, 0)
    assert.equal(audit.events.length, 0)
  })

  await test('érvénytelen katalógus fail-closed: a régi jelölés marad, és auditba megy a hiba', async () => {
    // `reversible: false` típusra tett tokenize — a forrás-szerződés §5.4 tiltja.
    const badCatalog = {
      catalog_version: 8,
      entity_types: { api_kulcs: { label: 'API-kulcs', reversible: false } },
      fields: {
        id: { type: 'integer', privacy: 'pass' },
        api_key: {
          type: 'string',
          privacy: 'tokenize',
          entity_type: 'api_kulcs',
          source_id: 'crm/api_kulcs/{id}',
        },
      },
    }
    const audit = recordingAudit()
    let persisted = 0
    const outcome = await syncPrivacyCatalogForConnectorRow(
      { id: CONNECTOR, name: 'CRM', type: 'http_api', tenantId: TENANT, secretAlias: null, config: STORED_CONFIG },
      { id: null },
      {
        audit: audit.repo,
        fetchCatalog: async () => ({
          ok: true,
          catalog: parsePrivacyCatalogV2(badCatalog) ?? (badCatalog as PrivacyCatalogV2),
        }),
        persist: async () => { persisted += 1 },
      },
    )
    assert.equal(outcome.status, 'failed')
    if (outcome.status !== 'failed') return
    assert.equal(outcome.reason, 'invalid_config')
    assert.match(outcome.detail, /visszafordítható/)
    assert.equal(persisted, 0, 'érvénytelen katalógus nem írhat felül működő jelölést')
    assert.equal(audit.events[0]?.action, 'privacy.catalog.sync.failed')
  })

  await test('elavult katalógusverzió fail-closed: kisebb version nem írhatja felül a frissebb tokenize jelölést', async () => {
    // v8: company_name tokenize. Stale v7 ugyanarra a mezőre pass-t adna → nyers PII.
    const currentConfig = {
      ...STORED_CONFIG,
      catalog_version: 8,
      fields: {
        ...STORED_CONFIG.fields,
        email: {
          type: 'string',
          privacy: 'tokenize',
          entity_type: 'company',
          source_id: 'crm/company/{id}',
        },
      },
    }
    const staleCatalog: PrivacyCatalogV2 = {
      ...SOURCE_CATALOG,
      catalog_version: 7,
      fields: {
        id: { type: 'integer', privacy: 'pass' },
        company_name: { type: 'string', privacy: 'pass' },
        email: { type: 'string', privacy: 'pass' },
      },
    }

    const direct = applyPrivacyCatalogToConfig(currentConfig, staleCatalog)
    assert.equal(direct.status, 'failed')
    if (direct.status !== 'failed') return
    assert.equal(direct.reason, 'stale_catalog')
    assert.match(direct.detail, /régebbi/)

    const audit = recordingAudit()
    let persisted = 0
    const outcome = await syncPrivacyCatalogForConnectorRow(
      {
        id: CONNECTOR,
        name: 'CRM',
        type: 'http_api',
        tenantId: TENANT,
        secretAlias: null,
        config: currentConfig,
      },
      { id: null },
      {
        audit: audit.repo,
        fetchCatalog: fetcherFor(staleCatalog),
        persist: async () => {
          persisted += 1
        },
      },
    )
    assert.equal(outcome.status, 'failed')
    if (outcome.status !== 'failed') return
    assert.equal(outcome.reason, 'stale_catalog')
    assert.equal(persisted, 0, 'elavult katalógus nem írhat felül frissebb jelölést')
    assert.equal(audit.events[0]?.action, 'privacy.catalog.sync.failed')
    assert.equal(
      (currentConfig.fields as Record<string, { privacy: string }>).email.privacy,
      'tokenize',
      'a tárolt tokenize jelölés érintetlen marad',
    )
  })

  await test('ugyanakkora vagy nagyobb katalógusverzió továbbra is alkalmazható', () => {
    const baseline = applyPrivacyCatalogToConfig(STORED_CONFIG, SOURCE_CATALOG)
    assert.equal(baseline.status, 'applied')
    if (baseline.status !== 'applied') return

    const atSame = applyPrivacyCatalogToConfig(baseline.config, SOURCE_CATALOG)
    assert.equal(atSame.status, 'no_change')

    const newer: PrivacyCatalogV2 = { ...SOURCE_CATALOG, catalog_version: 9 }
    const bumped = applyPrivacyCatalogToConfig(baseline.config, newer)
    assert.equal(bumped.status, 'applied')
    if (bumped.status !== 'applied') return
    assert.equal(bumped.catalogVersion, 9)
  })

  await test('elérhetetlen forrás nem törli a meglévő jelölést', async () => {
    const audit = recordingAudit()
    let persisted = 0
    const outcome = await syncPrivacyCatalogForConnectorRow(
      { id: CONNECTOR, name: 'CRM', type: 'http_api', tenantId: TENANT, secretAlias: null, config: STORED_CONFIG },
      { id: null },
      {
        audit: audit.repo,
        fetchCatalog: async () => ({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' }),
        persist: async () => { persisted += 1 },
      },
    )
    assert.equal(outcome.status, 'failed')
    assert.equal(persisted, 0)
    assert.equal(audit.events[0]?.action, 'privacy.catalog.sync.failed')
    assert.equal(
      inspectConnectorPrivacyFields(STORED_CONFIG).status,
      'valid',
      'a tárolt jelölés érintetlen marad',
    )
  })

  await test('sikeres szinkron auditja a katalógusverziót és a változásokat viszi', async () => {
    const audit = recordingAudit()
    const saved: Array<Record<string, unknown>> = []
    const outcome = await syncPrivacyCatalogForConnectorRow(
      { id: CONNECTOR, name: 'CRM', type: 'http_api', tenantId: TENANT, secretAlias: null, config: STORED_CONFIG },
      { id: 'user-1', type: 'human' },
      {
        audit: audit.repo,
        fetchCatalog: fetcherFor(SOURCE_CATALOG),
        persist: async (_id, config) => { saved.push(config) },
      },
    )
    assert.equal(outcome.status, 'applied')
    assert.equal(saved.length, 1)
    const event = audit.events[0]
    assert.equal(event?.action, 'privacy.catalog.sync.applied')
    assert.equal(event?.actorType, 'human')
    assert.equal(event?.tenantId, TENANT)
    const metadata = event?.metadata as { catalog_version: number; changes: string[] }
    assert.equal(metadata.catalog_version, 7)
    assert.ok(metadata.changes.length > 0)
  })

  await test('nem http_api kapcsolat: a szinkron nem fut le némán, hanem indokolt hibát ad', async () => {
    const outcome = await syncConnectorPrivacyCatalog({
      connector: { type: 'gmail', config: STORED_CONFIG },
      fetchCatalog: fetcherFor(SOURCE_CATALOG),
    })
    assert.equal(outcome.status, 'failed')
    if (outcome.status !== 'failed') return
    assert.equal(outcome.reason, 'not_http_api')
  })

  await test('a katalógus-végpont `restrictToEndpoints` mellett is hívható (platform-hívás, nem modell-hívás)', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url))
      void init
      return new Response(JSON.stringify(SOURCE_CATALOG), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    try {
      const result = await fetchConnectorPrivacyCatalog({
        config: {
          ...STORED_CONFIG,
          auth: { scheme: 'bearer' },
          restrictToEndpoints: true,
        },
        apiKey: 'secret-token',
      })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.catalog.catalog_version, 7)
      assert.match(calls[0] ?? '', /\/api\/connector\/v1\/privacy\/catalog$/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nMinden katalógus-szinkron teszt zöld')
}

void main()
