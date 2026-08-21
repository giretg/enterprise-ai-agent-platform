/**
 * APG-22 — Privacy observability UI (spec §14).
 *
 * DoD: OBSERVE-ban egy valós CRM-fordulón végigkövethető a lánc; a felület magyar,
 * zsargon nélküli, és van üres állapota.
 *
 * Futtatás: npm run test:privacy-observability-ui
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import {
  PRIVACY_OBSERVABILITY_EMPTY,
  PRIVACY_OBSERVABILITY_INTRO,
  PRIVACY_TRANSFORM_STATUS_LABELS,
} from '../src/domain/privacy/privacy-observability-copy'
import {
  applyTransformPreview,
  buildEntityMarkers,
  buildPrivacyTurnChain,
  markerTooltipText,
} from '../src/domain/privacy/privacy-observability'
import { resolvePrivacyCategoryPolicy } from '../src/domain/privacy/privacy-category-policy'
import { buildPrivacyAwareOutcomeChannels } from '../src/domain/tool-broker/tool-output-privacy'
import { resolveToolOutputContract } from '../src/domain/tool-broker/tool-output-contracts'
import { isSideEffectingTool, resolveTrustClass } from '../src/domain/tool-broker/tool-trust-registry'
import type { Connector } from '@prisma/client'
import { PrivacyHighlightedText } from '../src/components/privacy/privacy-highlighted-text'

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

const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
const EMAIL = 'ada.lovelace@spar.hu'
const OTHER_COMPANY = 'Tesco Globál Áruházak Zrt.'
const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'

const CRM_FIELDS = {
  ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
  email: {
    type: 'string' as const,
    privacy: 'tokenize' as const,
    entity_type: 'email' as const,
    source_id: 'crm/email/{id}',
  },
}

function crmConnector(): Connector {
  return {
    id: CONNECTOR,
    tenantId: TENANT,
    type: 'workspace',
    authMode: 'none',
    config: { fields: CRM_FIELDS },
  } as unknown as Connector
}

function crmRows() {
  return [
    { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
    { id: 7, company_name: OTHER_COMPANY, email: 'beszerzes@tesco.hu', revenue: 20 },
    { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 10 },
  ]
}

function assertNoJargon(text: string) {
  assert.equal(/OBSERVE/.test(text) && !/Megfigyel/.test(text), false)
  assert.equal(/\[\[COMPANY_\d+\]\]/.test(text), false, 'a normál magyarázatban ne legyen technikai álnév')
}

async function main() {
  console.log('APG-22 privacy observability UI\n')

  await test('üres állapot: közérthető magyar szöveg, zsargon nélkül', () => {
    const chain = buildPrivacyTurnChain({
      mode: 'observe',
      policy: resolvePrivacyCategoryPolicy({}),
      originalText: '',
    })
    assert.equal(chain.empty, true)
    assert.equal(chain.markerCount, 0)
    assertNoJargon(PRIVACY_OBSERVABILITY_EMPTY.title)
    assertNoJargon(PRIVACY_OBSERVABILITY_EMPTY.body)
    assertNoJargon(PRIVACY_OBSERVABILITY_INTRO)
  })

  await test('OBSERVE CRM-forduló: 6 strukturált marker, modell-bemenet nyers', async () => {
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const rawResult = {
      sheet: 'Cégek',
      headers: ['id', 'company_name', 'email', 'revenue'],
      rows: crmRows(),
      rowCount: 3,
    }
    const channels = await buildPrivacyAwareOutcomeChannels({
      tool: 'xlsx_read_sheet',
      trust: resolveTrustClass('xlsx_read_sheet'),
      output: rawResult,
      contract: resolveToolOutputContract('xlsx_read_sheet'),
      sideEffecting: isSideEffectingTool('xlsx_read_sheet'),
      connector: crmConnector(),
      actingTenantId: TENANT,
      mode: 'observe',
    })
    assert.equal(channels.modelText.includes(COMPANY), true)
    assert.equal(channels.modelText.includes('[[COMPANY_'), false)

    const markers = buildEntityMarkers({
      text: channels.modelText,
      policy,
      mode: 'observe',
      structuredOutput: rawResult,
      connectorFields: CRM_FIELDS,
    })
    assert.equal(markers.length, 6)
    assert.equal(markers.every((marker) => marker.status === 'observed'), true)
    assert.equal(markers.filter((marker) => marker.category === 'company').length, 3)
    assert.equal(markers.filter((marker) => marker.category === 'email').length, 3)

    const chain = buildPrivacyTurnChain({
      mode: 'observe',
      policy,
      originalText: channels.modelText,
      structuredOutput: rawResult,
      connectorFields: CRM_FIELDS,
      llmOutputText: `A legnagyobb cég a listán: ${COMPANY}.`,
      userOutputText: `A legnagyobb cég a listán: ${COMPANY}.`,
    })
    assert.equal(chain.stages.length, 5)
    assert.equal(chain.stages[0]?.id, 'original')
    assert.equal(chain.stages[2]?.id, 'llm_input')
    assert.equal(chain.stages[2]?.text.includes(COMPANY), true)
    assert.equal(chain.stages[2]?.text.includes('[[COMPANY_'), false)
    assert.ok(chain.stages[1]?.summary?.includes('6 védendő adat'))
    assert.ok(chain.stages[1]?.summary?.includes('Megfigyelés'))
    assertNoJargon(chain.stages[1]?.summary ?? '')
  })

  await test('ENFORCE: modell-bemenet álneveket kap, felhasználói kimenet nyers maradhat', async () => {
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { company: 'tokenize', email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const snippet = `Cég: ${COMPANY}, e-mail: ${EMAIL}`
    const markers = buildEntityMarkers({
      text: snippet,
      policy,
      mode: 'enforce',
      structuredOutput: { company_name: COMPANY, email: EMAIL },
      connectorFields: CRM_FIELDS,
    })
    const llmInput = applyTransformPreview(snippet, markers, 'enforce')
    assert.equal(llmInput.includes(COMPANY), false)
    assert.equal(llmInput.includes(EMAIL), false)
    assert.match(llmInput, /\[\[COMPANY_1\]\]/)
    assert.match(llmInput, /\[\[EMAIL_1\]\]/)

    const chain = buildPrivacyTurnChain({
      mode: 'enforce',
      policy,
      originalText: snippet,
      structuredOutput: { company_name: COMPANY, email: EMAIL },
      connectorFields: CRM_FIELDS,
      llmOutputText: '[[COMPANY_1]] adatai frissítve.',
      userOutputText: `${COMPANY} adatai frissítve.`,
    })
    assert.equal(chain.stages[2]?.text.includes('[[COMPANY_1]]'), true)
    assert.equal(chain.stages[4]?.text.includes(COMPANY), true)
  })

  await test('hover magyarázat: entitástípus + státusz, technikai álnév nélkül', () => {
    const policy = resolvePrivacyCategoryPolicy({})
    const markers = buildEntityMarkers({
      text: COMPANY,
      policy,
      mode: 'observe',
      structuredOutput: { company_name: COMPANY },
      connectorFields: CRM_FIELDS,
    })
    assert.ok(markers.length >= 1)
    const tooltip = markerTooltipText(markers[0]!)
    assert.ok(tooltip.includes('Cégnév'))
    assert.ok(tooltip.includes('Megfigyelve'))
    assertNoJargon(tooltip)
    assert.equal(Object.values(PRIVACY_TRANSFORM_STATUS_LABELS).every((row) => row.label.length > 2), true)
  })

  await test('minta-alapú találat: e-mail cím megfigyelve OBSERVE alatt', () => {
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const text = `Írj az ${EMAIL} címre.`
    const markers = buildEntityMarkers({ text, policy, mode: 'observe' })
    assert.equal(markers.length, 1)
    assert.equal(markers[0]?.displayValue, EMAIL)
    assert.equal(markers[0]?.status, 'observed')
  })

  await test('valós chat-output: feloldott known-value kiemelve, technikai álnév nélkül', () => {
    const text = `${COMPANY} adatai frissítve.`
    const markers = buildEntityMarkers({
      text,
      policy: resolvePrivacyCategoryPolicy({}),
      mode: 'enforce',
      knownValues: [{
        needle: COMPANY,
        surrogate: '[[COMPANY_1]]',
        fromStructuredField: true,
      }],
    })
    assert.equal(markers.length, 1)
    const html = renderToStaticMarkup(
      PrivacyHighlightedText({ text, markers }) ?? null,
    )
    assert.ok(html.includes(COMPANY))
    assert.equal(html.includes('[[COMPANY_1]]'), false)
    assert.ok(html.includes('Cégnév'))
  })

  await test('APG-22: a chat-felület a kiemelő komponenst használja', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'src/components/agents/agent-chat-panel.tsx'), 'utf8')
    assert.match(src, /PrivacyHighlightedText/)
    assert.match(src, /privacyMarkers/)
    assert.match(src, /PrivacyObservedText/)
    assert.match(src, /privacyContext/)
  })

  await test('OBSERVE: strukturált mező preview szótárba kerül vault nélkül', async () => {
    const { SurrogateEngine } = await import('../src/domain/privacy/surrogate-engine')
    const engine = new SurrogateEngine(
      { findRef: async () => ({ status: 'miss' }), insertRef: async () => {}, findValByFingerprint: async () => ({ status: 'miss' }), insertVal: async () => {} } as never,
      { append: async () => {} } as never,
    )
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { company: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const rawResult = {
      company_name: COMPANY,
      id: 1,
    }
    const { transformStructuredOutput } = await import('../src/domain/privacy/structured-output-transform')
    await transformStructuredOutput({
      output: rawResult,
      fields: CRM_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope: { type: 'conversation', id: 'conv-observe-ui' },
      apply: false,
      registerObserved: true,
    })
    const observeText = `Riport: ${COMPANY} és spar_rendeles.html`
    const markers = buildEntityMarkers({
      text: observeText,
      policy,
      mode: 'observe',
      knownValues: engine.listKnownValueReplacements(
        TENANT,
        { type: 'conversation', id: 'conv-observe-ui' },
        { includeObservePreviews: true },
      ),
    })
    assert.ok(markers.some((m) => m.displayValue === COMPANY))
    assert.ok(
      markers.some((m) => observeText.slice(m.start, m.end).toLowerCase() === 'spar'),
      'a szótár első tokenje illeszkedjen a fájlnévben is',
    )
    assert.deepEqual(
      engine.listKnownValueReplacements(TENANT, { type: 'conversation', id: 'conv-observe-ui' }),
      [],
      'OBSERVE preview ne kerüljön a prompt known-value szótárába',
    )
  })

  await test('OBSERVE preview után ENFORCE known-value ne cseréljen vault nélküli álnévre', async () => {
    const { SurrogateEngine } = await import('../src/domain/privacy/surrogate-engine')
    const engine = new SurrogateEngine(
      {
        findRef: async () => ({ status: 'miss' }),
        insertRef: async () => {},
        findValByFingerprint: async () => ({ status: 'miss' }),
        insertVal: async () => {},
      } as never,
      { append: async () => {} } as never,
    )
    const { transformStructuredOutput } = await import('../src/domain/privacy/structured-output-transform')
    await transformStructuredOutput({
      output: { company_name: COMPANY, id: 1 },
      fields: CRM_FIELDS,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope: { type: 'conversation', id: 'conv-observe-then-enforce' },
      apply: false,
      registerObserved: true,
    })

    const { substituteKnownValuesInText } = await import('../src/domain/privacy/known-value-substitution')
    const text = `Frissítsd a(z) ${COMPANY} rekordot`
    const result = await substituteKnownValuesInText({
      text,
      replacements: engine.listKnownValueReplacements(TENANT, {
        type: 'conversation',
        id: 'conv-observe-then-enforce',
      }),
      mode: 'enforce',
    })
    assert.equal(result.text, text)
    assert.equal(result.appliedCount, 0)
    assert.equal(result.text.includes('[[COMPANY_'), false)

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld')
}

void main()
