/**
 * APG-03 — connector privacy metadata + capability-deklaráció.
 *
 * Futtatás: npm run test:connector-privacy
 *
 * DoD: numerikus mezőre tett `tokenize` mentéskor elbukik érthető hibával;
 * a CRM connector capabilitySet-je tartalmazza a deklarációt.
 */
import assert from 'node:assert/strict'
import { parseCapabilitySet } from '../src/domain/connector-self-update/capability-set'
import { computeCapabilityDiff } from '../src/domain/connector-self-update/spec-diff'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/custom-template-seeds'
import { enrichOstorosborConnectorConfig } from '../src/domain/connector-template/ostorosbor-config-enrichment'
import { materializeConnectorConfig, selfCheckTemplateDescriptor } from '../src/domain/connector-template/materializer'
import { parseTemplateDescriptor } from '../src/domain/connector-template/template-descriptor'
import {
  ConnectorConfigParseError,
  normalizeConnectorConfig,
  type ConnectorConfig,
} from '../src/domain/provisioning/connector-config'
import { effectiveConnectorRuntimeConfig } from '../src/domain/connector-template/ostorosbor-config-enrichment'
import { entityTypeHintFromConnectorConfig } from '../src/domain/privacy/entity-resolution-runtime'
import {
  OSTOROSBOR_CRM_PRIVACY_CAPABILITIES,
  OSTOROSBOR_CRM_PRIVACY_CATALOG,
  TOKENIZE_IRREVERSIBLE_MESSAGE,
  TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE,
  TOKENIZE_STRING_ONLY_MESSAGE,
  inspectConnectorPrivacyFields,
  parsePrivacyCatalogV2,
  privacyCatalogToConnectorConfigPatch,
  readConnectorEntityTypes,
  readConnectorPrivacyFields,
  readConnectorUnlistedDefault,
  privacyCapabilityAbsentAudit,
  privacyCapabilityChangedAudit,
  privacyCapabilityLevel,
  readPrivacyDeclaration,
} from '../src/domain/privacy/connector-privacy'

let failures = 0
function pass(name: string) {
  console.log(`  ✓ ${name}`)
}
function fail(name: string, err: unknown) {
  failures += 1
  console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
}
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    pass(name)
  } catch (err) {
    fail(name, err)
  }
}

function baseConfig(overrides: Partial<ConnectorConfig> = {}): Record<string, unknown> {
  return {
    provider: 'acme',
    baseUrl: 'https://api.example/v1',
    egressHosts: ['api.example'],
    authMode: 'service',
    auth: { type: 'bearer_token' },
    scopesSuggested: [],
    proposedTools: [{ name: 'list', method: 'GET', path: '/items', access: 'read' }],
    ...overrides,
  }
}

async function main() {
  console.log('connector privacy metadata (APG-03)')

  await test('privacy nélküli legacy config továbbra is menthető', () => {
    const config = normalizeConnectorConfig(baseConfig())
    assert.equal(config.privacy, undefined)
    assert.equal(config.fields, undefined)
    assert.equal(privacyCapabilityLevel(config.privacy), 'none')
  })

  await test('numerikus mezőre tett tokenize mentéskor elbukik, érthető hibával', () => {
    assert.throws(
      () =>
        normalizeConnectorConfig(
          baseConfig({
            fields: {
              revenue: { type: 'number', privacy: 'tokenize', entity_type: 'company' },
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorConfigParseError)
        assert.ok(
          err.message.includes(TOKENIZE_STRING_ONLY_MESSAGE),
          `hibaüzenet nem magyarázza a tiltást: ${err.message}`,
        )
        assert.ok(/fields\.revenue/.test(err.message), `útvonal hiányzik: ${err.message}`)
        return true
      },
    )
  })

  await test('dátum mezőre tett tokenize szintén elbukik', () => {
    assert.throws(
      () =>
        normalizeConnectorConfig(
          baseConfig({
            fields: {
              founded_at: { type: 'date', privacy: 'tokenize', entity_type: 'company' },
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorConfigParseError)
        assert.ok(err.message.includes(TOKENIZE_STRING_ONLY_MESSAGE))
        return true
      },
    )
  })

  await test('string mező tokenize + company entitástípus menthető', () => {
    const config = normalizeConnectorConfig(
      baseConfig({
        privacy: OSTOROSBOR_CRM_PRIVACY_CAPABILITIES,
        fields: {
          company_name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'company',
            source_id: 'crm/company/4821',
          },
          revenue: { type: 'number', privacy: 'pass' },
        },
      }),
    )
    assert.equal(config.fields?.company_name.privacy, 'tokenize')
    assert.equal(config.fields?.company_name.entity_type, 'company')
    assert.equal(config.fields?.revenue.privacy, 'pass')
    assert.equal(privacyCapabilityLevel(config.privacy), 'full')
  })

  await test('legacy tokenize source_id nélkül továbbra is beolvasható (runtime ENFORCE fail-closed)', () => {
    const config = normalizeConnectorConfig(
      baseConfig({
        fields: {
          company_name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'company',
          },
        },
      }),
    )
    assert.equal(config.fields?.company_name?.privacy, 'tokenize')
    const inspected = inspectConnectorPrivacyFields(config)
    assert.equal(inspected.status, 'valid')
  })

  await test('hibás fields séma inspect-ben invalid, nem absent (fail-closed, nem néma fail-open)', () => {
    const inspected = inspectConnectorPrivacyFields({
      fields: {
        revenue: { type: 'number', privacy: 'tokenize', entity_type: 'company' },
      },
    })
    assert.equal(inspected.status, 'invalid')
    if (inspected.status === 'invalid') {
      assert.match(inspected.reason, /tokenize/)
    }
  })

  await test('source_id sablon csak létező payload-mezőre hivatkozhat', () => {
    assert.throws(
      () =>
        normalizeConnectorConfig(
          baseConfig({
            fields: {
              company_name: {
                type: 'string',
                privacy: 'tokenize',
                entity_type: 'company',
                source_id: 'crm/company/{missing_id}',
              },
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorConfigParseError)
        assert.ok(err.message.includes(TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE))
        return true
      },
    )
  })

  await test('a forrás entitástípus-névtere és unlisted_default-ja túléli a normalizálást', () => {
    const config = normalizeConnectorConfig(
      baseConfig({
        entity_types: {
          ingatlan: { label: 'Ingatlan', reversible: true },
        },
        unlisted_default: 'block',
        catalog_version: 4,
        fields: {
          id: { type: 'integer', privacy: 'pass' },
          hrsz: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'ingatlan',
            source_id: 'crm/ingatlan/{id}',
          },
        },
      } as Partial<ConnectorConfig>),
    )
    assert.equal(config.entity_types?.ingatlan?.label, 'Ingatlan')
    assert.equal(config.unlisted_default, 'block')
    assert.equal(config.catalog_version, 4)

    // futásidőben ugyanezt kell látni — enélkül a forrás-egyedi típus és a
    // jelöletlen mezők kizárása némán elveszne
    const runtime = effectiveConnectorRuntimeConfig(config)
    assert.equal(readConnectorEntityTypes(runtime).ingatlan?.label, 'Ingatlan')
    assert.equal(readConnectorUnlistedDefault(runtime), 'block')
    assert.equal(readConnectorPrivacyFields(runtime)?.hrsz?.entity_type, 'ingatlan')
  })

  await test('reversible: false típusra tett tokenize mentéskor elbukik és futásidőben is invalid', () => {
    const raw = baseConfig({
      entity_types: {
        api_kulcs: { label: 'API-kulcs', reversible: false },
      },
      fields: {
        id: { type: 'integer', privacy: 'pass' },
        api_key: {
          type: 'string',
          privacy: 'tokenize',
          entity_type: 'api_kulcs',
          source_id: 'crm/api_kulcs/{id}',
        },
      },
    } as Partial<ConnectorConfig>)

    assert.throws(
      () => normalizeConnectorConfig(raw),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorConfigParseError)
        assert.ok(err.message.includes(TOKENIZE_IRREVERSIBLE_MESSAGE), err.message)
        return true
      },
    )
    // fail-closed: ha egy ilyen sor mégis a DB-ben van, a futásidő nem tokenizál némán
    const inspected = inspectConnectorPrivacyFields(effectiveConnectorRuntimeConfig(raw))
    assert.equal(inspected.status, 'invalid')
  })

  await test('a forrás katalógusa bemásolható a connector-configba (séma-azonosság)', () => {
    const catalog = parsePrivacyCatalogV2(OSTOROSBOR_CRM_PRIVACY_CATALOG)
    assert.ok(catalog)
    const patch = privacyCatalogToConnectorConfigPatch(catalog)
    const config = normalizeConnectorConfig(baseConfig(patch as Partial<ConnectorConfig>))
    assert.equal(config.fields?.company_name.entity_type, 'company')
    assert.equal(config.entity_types?.company?.reversible, true)
    assert.equal(config.unlisted_default, 'pass')
    assert.equal(config.catalog_version, OSTOROSBOR_CRM_PRIVACY_CATALOG.catalog_version)
  })

  await test('idegen forrás nem örökli a CRM mezőjelölését az útvonal-végződés miatt', () => {
    const foreign = normalizeConnectorConfig(
      baseConfig({
        provider: 'masik-rendszer',
        baseUrl: 'https://masik.example/api/connector/v1',
        egressHosts: ['masik.example'],
      }),
    )
    const runtime = effectiveConnectorRuntimeConfig(foreign)
    assert.equal(inspectConnectorPrivacyFields(runtime).status, 'absent')
    assert.equal(readConnectorPrivacyFields(runtime), null)
  })

  await test('a resolve entitástípus-tippje a deklarációból jön, nem platform-találgatásból', () => {
    const ingatlan = normalizeConnectorConfig(
      baseConfig({
        entity_types: { ingatlan: { label: 'Ingatlan', reversible: true } },
        fields: {
          id: { type: 'integer', privacy: 'pass' },
          hrsz: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'ingatlan',
            source_id: 'crm/ingatlan/{id}',
          },
        },
      } as Partial<ConnectorConfig>),
    )
    assert.equal(entityTypeHintFromConnectorConfig(ingatlan), 'ingatlan')

    // több deklarált típusnál a forrás dönt: nem küldünk félrevezető tippet
    const multi = normalizeConnectorConfig(
      baseConfig({
        fields: {
          id: { type: 'integer', privacy: 'pass' },
          company_name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'company',
            source_id: 'crm/company/{id}',
          },
          contact_name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'person',
            source_id: 'crm/person/{id}',
          },
        },
      }),
    )
    assert.equal(entityTypeHintFromConnectorConfig(multi), undefined)
    assert.equal(entityTypeHintFromConnectorConfig(normalizeConnectorConfig(baseConfig())), undefined)
  })

  await test('CRM sablon capabilitySet-je tartalmazza a privacy-deklarációt és a company mezőt', () => {
    for (const key of ['ostorosbor-crm-sales-delegated', 'ostorosbor-crm-service-insight'] as const) {
      const raw = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === key)
      assert.ok(raw, `hiányzó CRM sablon: ${key}`)
      const config = materializeConnectorConfig(
        parseTemplateDescriptor(raw),
        {
          authMethodKind: 'bearer',
          instanceValues: {
            crmHost: 'crm.example',
            actingUserEmail: 'agent@example.com',
          },
        },
        { apiKey: 'secret-ref:ostorosbor-crm-api-key' },
      )
      const capabilitySet = parseCapabilitySet(config)
      assert.ok(capabilitySet, `${key}: a materializált config nem capabilitySet`)
      assert.deepEqual(capabilitySet.privacy, OSTOROSBOR_CRM_PRIVACY_CAPABILITIES)
      assert.equal(capabilitySet.fields?.company_name.entity_type, 'company')
      assert.equal(capabilitySet.fields?.company_name.privacy, 'tokenize')
      assert.equal(capabilitySet.fields?.company_name.type, 'string')
      assert.equal(capabilitySet.fields?.revenue.privacy, 'pass')
    }
  })

  await test('régi CRM config privacy nélkül runtime-ban megkapja a deklarációt', () => {
    const { config, changed } = enrichOstorosborConnectorConfig(
      normalizeConnectorConfig(
        baseConfig({
          provider: 'ostorosbor-crm-sales-delegated',
          baseUrl: 'https://crm.example/api/connector/v1',
          egressHosts: ['crm.example'],
        }),
      ),
    )
    assert.equal(changed, true)
    assert.deepEqual(config.privacy, OSTOROSBOR_CRM_PRIVACY_CAPABILITIES)
    assert.equal(config.fields?.company_name.entity_type, 'company')
  })

  await test('privacy nélküli külső connector UI+audit alacsonyabb capability-t jelez', () => {
    const github = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === 'github')
    assert.ok(github)
    const config = selfCheckTemplateDescriptor(parseTemplateDescriptor(github))
    assert.equal(config.privacy, undefined)
    assert.equal(privacyCapabilityLevel(readPrivacyDeclaration(config)), 'none')
    const absent = privacyCapabilityAbsentAudit(config.privacy)
    assert.equal(absent?.action, 'privacy.connector.capability.absent')
    assert.equal(absent?.metadata.privacy_capability, 'none')
  })

  await test('capability-deklaráció változása diffben és auditban megjelenik', () => {
    const without = normalizeConnectorConfig(baseConfig())
    const withPrivacy = normalizeConnectorConfig(
      baseConfig({ privacy: OSTOROSBOR_CRM_PRIVACY_CAPABILITIES }),
    )
    const added = computeCapabilityDiff(without, withPrivacy)
    assert.ok(added.added.some((item) => item.change === 'privacy_capability_added: structured_field_privacy'))
    assert.ok(added.added.some((item) => item.change === 'privacy_capability_added: stable_entity_ids'))

    const removed = computeCapabilityDiff(withPrivacy, without)
    assert.ok(removed.breaking.some((item) => item.change === 'privacy_capability_removed: structured_field_privacy'))
    assert.equal(removed.highestRisk, 'high')

    const changed = privacyCapabilityChangedAudit({
      previous: without.privacy,
      next: withPrivacy.privacy,
    })
    assert.equal(changed?.action, 'privacy.connector.capability.changed')
    assert.equal(changed?.metadata.privacy_capability, 'full')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
