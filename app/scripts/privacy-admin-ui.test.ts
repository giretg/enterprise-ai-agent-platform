/**
 * APG-14 — Admin UI: kategória-policy szerkesztő + dry-run teszter.
 *
 * DoD: a felület magyarul, zsargon nélkül elmagyarázza, mi történik;
 * a dry-run egyetlen külső hívást sem indít.
 *
 * Futtatás: npm run test:privacy-admin-ui
 */
import assert from 'node:assert/strict'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import { connectorHasPrivacyMetadata } from '../src/domain/privacy/connector-privacy'
import { connectorRowHasPrivacyMetadata } from '../src/domain/privacy/connector-privacy-runtime'
import {
  ALIAS_LAYER_INTRO,
  PRIVACY_EMPTY_CONNECTOR_STATE,
  PRIVACY_GLOSSARY,
  PRIVACY_MODE_LABELS,
  PRIVACY_PAGE_INTRO,
  SENSITIVITY_LAYER_INTRO,
  SENSITIVITY_MODE_LABELS,
  inheritedFromLabel,
  privacyCatalogSyncMessage,
  privacyConnectorEmptyState,
} from '../src/domain/privacy/privacy-admin-copy'
import type { PrivacyCatalogSyncFailReason } from '../src/domain/privacy/privacy-catalog-sync'
import {
  buildPrivacyPolicyEditorRows,
  DEFAULT_PRIVACY_CATEGORY_POLICY,
  isAliasPolicyEditorCategory,
  isSensitivityScannerCategory,
  isSourceCatalogPrivacyCategory,
  resolvePrivacyCategoryPolicy,
} from '../src/domain/privacy/privacy-category-policy'
import { previewAliasForCategory, runPrivacyDryRun } from '../src/domain/privacy/privacy-dry-run'

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

function assertNoJargonDump(text: string) {
  assert.equal(/OBSERVE/.test(text) && !/Megfigyelés/.test(text), false)
  assert.ok(text.length > 20, 'a magyarázat legyen egymondatos, ne üres')
}

async function main() {
  console.log('APG-14 admin UI: kategória-policy + dry-run\n')

  await test('dry-run: e-mailre local_only, álnév nélkül, modellhívás nélkül', () => {
    const policy = resolvePrivacyCategoryPolicy({})
    const result = runPrivacyDryRun({
      text: 'Írj az anna@spar.hu címre a ajánlatról.',
      policy,
      mode: 'enforce',
    })
    assert.equal(result.calledExternalModel, false)
    assert.equal(result.wroteVault, false)
    const email = result.hits.find((hit) => hit.category === 'email')
    assert.ok(email, 'az e-mail-címet fel kell ismerni')
    assert.equal(email?.action, 'local_only')
    assert.equal(email?.alias, null)
    assert.ok(email?.outcome.includes('helyi modell') || email?.outcome.includes('megáll'))
  })

  await test('dry-run: tokenize e-mail [[EMAIL_1]] előnézetet ad, vault nélkül', () => {
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const result = runPrivacyDryRun({
      text: 'Írj az anna@spar.hu címre.',
      policy,
      mode: 'enforce',
    })
    const email = result.hits.find((hit) => hit.category === 'email')
    assert.equal(email?.action, 'tokenize')
    assert.equal(email?.alias, '[[EMAIL_1]]')
    assert.equal(result.wroteVault, false)
    assert.equal(result.calledExternalModel, false)
  })

  await test('dry-run: OBSERVE módban a tokenize is csak feljegyezné, a modell nyers adatot kapna', () => {
    const policy = resolvePrivacyCategoryPolicy({
      platform: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
    })
    const result = runPrivacyDryRun({
      text: 'anna@spar.hu',
      policy,
      mode: 'observe',
    })
    const email = result.hits.find((hit) => hit.category === 'email')
    assert.ok(email?.outcome.includes('Megfigyelés'))
    assert.ok(email?.outcome.includes('valódi adat'))
    assert.equal(result.calledExternalModel, false)
  })

  await test('dry-run: bankkártya alapból tiltva, nincs álnév', () => {
    const policy = resolvePrivacyCategoryPolicy({})
    const result = runPrivacyDryRun({
      text: 'A kártyaszámom: 4111111111111111 — segíts!',
      policy,
      mode: 'enforce',
    })
    const pan = result.hits.find((hit) => hit.category === 'pan' || hit.category === 'card_broad')
    assert.ok(pan)
    assert.equal(pan?.action, DEFAULT_PRIVACY_CATEGORY_POLICY.pan)
    assert.equal(pan?.alias, null)
    assert.ok(pan?.outcome.includes('megáll'))
  })

  await test('dry-run előnézet típusos álnevet ad, nem opaque hash-t', () => {
    assert.equal(previewAliasForCategory('email', 1), '[[EMAIL_1]]')
    assert.equal(previewAliasForCategory('company', 2), '[[COMPANY_2]]')
    assert.equal(previewAliasForCategory('taj', 1), '[[TAJ_1]]')
    assert.equal(/^[a-f0-9]{16,}$/i.test(previewAliasForCategory('email', 1)), false)
  })

  await test('öröklés: a tenant overlay győz, a többi sor örököltnek látszik', () => {
    const rows = buildPrivacyPolicyEditorRows({
      platform: {
        categories: { phone: 'block' },
        custom: {},
        updatedById: null,
        updatedAt: null,
        patternSetVersion: 1,
      },
      tenant: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
      editingLayer: 'tenant',
    })
    const email = rows.find((row) => row.category === 'email')
    const phone = rows.find((row) => row.category === 'phone')
    const company = rows.find((row) => row.category === 'company')
    assert.equal(email?.inherited, false)
    assert.equal(email?.source, 'tenant')
    assert.equal(email?.resolvedAction, 'tokenize')
    assert.equal(phone?.inherited, true)
    assert.equal(phone?.source, 'platform')
    assert.equal(phone?.resolvedAction, 'block')
    assert.equal(company?.inherited, true)
    assert.equal(company?.source, 'default')
    assert.equal(inheritedFromLabel(phone!.source), 'örökölt (platform)')
    assert.equal(inheritedFromLabel(company!.source), 'örökölt (alapértelmezés)')
    assert.equal(isSourceCatalogPrivacyCategory('company'), true)
    assert.equal(isAliasPolicyEditorCategory('company'), false)
    assert.equal(isAliasPolicyEditorCategory('email'), true)
  })

  await test('öröklés: agent rétegen a tenant telefon-szabálya látszik örököltnek', () => {
    const rows = buildPrivacyPolicyEditorRows({
      tenant: {
        categories: { phone: 'block' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
      agent: {
        categories: {},
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
      editingLayer: 'agent',
    })
    const phone = rows.find((row) => row.category === 'phone')
    assert.equal(phone?.inherited, true)
    assert.equal(phone?.source, 'tenant')
    assert.equal(phone?.overlayAction, null)
  })

  await test('„Szinkron most" — sikeres szinkron megmondja a verziót és a változásokat', () => {
    const message = privacyCatalogSyncMessage({
      status: 'applied',
      catalogVersion: 7,
      changes: ['mező hozzáadva: hrsz → tokenize/ingatlan', 'jelöletlen mezők: pass → block'],
    })
    assert.equal(message.tone, 'ok')
    assert.match(message.text, /katalógus v7/)
    assert.match(message.text, /2 változás/)
    assert.match(message.text, /hrsz/)
  })

  await test('„Szinkron most" — a D5 figyelmeztetés látszik, és sárgára vált', () => {
    const message = privacyCatalogSyncMessage({
      status: 'applied',
      catalogVersion: 7,
      changes: ['mező módosult: token — pass → pass'],
      warnings: ['token: API-kulcs minta (sk-…)'],
    })
    assert.equal(message.tone, 'warn')
    assert.match(message.text, /Ellenőrizd/)
    assert.match(message.text, /API-kulcs minta/)
  })

  await test('„Szinkron most" — változatlan katalógus nem ijesztget', () => {
    const message = privacyCatalogSyncMessage({ status: 'no_change', catalogVersion: 4 })
    assert.equal(message.tone, 'ok')
    assert.match(message.text, /változatlan/)
    assert.match(message.text, /nincs teendő/)
  })

  await test('„Szinkron most" — minden hibaokra magyar mondat van, és kimondja, hogy a régi jelölés marad', () => {
    const reasons: PrivacyCatalogSyncFailReason[] = [
      'not_http_api',
      'unreachable',
      'http_error',
      'invalid_catalog',
      'invalid_config',
    ]
    for (const reason of reasons) {
      const message = privacyCatalogSyncMessage({ status: 'failed', reason, detail: 'részlet' })
      assert.equal(message.tone, 'err')
      assert.doesNotMatch(message.text, /^A szinkron nem sikerült/, `hiányzó magyar szöveg: ${reason}`)
      assert.doesNotMatch(message.text, new RegExp(reason), `nyers hibakód szivárog: ${reason}`)
      assert.match(
        message.text,
        /A korábbi jelölés érvényben marad/,
        `a fail-closed ígéret hiányzik: ${reason}`,
      )
    }
  })

  await test('üres állapot: nincs privacy-metadata-s connector — közérthető teendő, nem üres táblázat', () => {
    const empty = privacyConnectorEmptyState([
      { id: 'c1', name: 'Gmail', hasPrivacyMetadata: false },
    ])
    assert.equal(empty.kind, 'empty')
    assert.equal(empty.ready.length, 0)
    assert.equal(empty.title, PRIVACY_EMPTY_CONNECTOR_STATE.title)
    assert.ok(empty.body?.includes('Kapcsolatok'))
    assert.ok(empty.body?.includes('katalógus'))
    assert.ok(empty.cta)
    assert.ok(empty.href)
  })

  await test('önfrissítő CRM: a pinned snapshot privacy-kész, az üres tárolt config nem', () => {
    const stored = {}
    const capabilitySet = {
      provider: 'ostoros-crm-autorefresh',
      baseUrl: 'https://ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app/api/connector/v1',
      egressHosts: ['ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app'],
      authMode: 'service' as const,
      auth: { type: 'bearer_token' as const },
      scopesSuggested: [] as string[],
      proposedTools: [{ name: 'listAccounts', method: 'GET' as const, path: '/accounts', access: 'read' as const }],
    }
    assert.equal(
      connectorRowHasPrivacyMetadata({ connectorMode: 'self_updating', config: stored }),
      false,
    )
    assert.equal(
      connectorRowHasPrivacyMetadata({
        connectorMode: 'self_updating',
        config: stored,
        capabilitySet,
      }),
      true,
    )
    const ready = privacyConnectorEmptyState([
      {
        id: 'crm',
        name: 'Ostoros CRM Autorefresh',
        hasPrivacyMetadata: connectorRowHasPrivacyMetadata({
          connectorMode: 'self_updating',
          config: stored,
          capabilitySet,
        }),
      },
    ])
    assert.equal(ready.kind, 'ready')
    assert.equal(ready.ready[0]?.name, 'Ostoros CRM Autorefresh')
  })

  await test('üres állapot: privacy-metadata-s CRM kapcsolat késznek számít', () => {
    assert.equal(
      connectorHasPrivacyMetadata({
        fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
        privacy: {
          structured_field_privacy: true,
          stable_entity_ids: true,
          entity_resolution: false,
          free_text_hints: false,
        },
      }),
      true,
    )
    const ready = privacyConnectorEmptyState([
      { id: 'crm', name: 'Ostorosbor CRM', hasPrivacyMetadata: true },
    ])
    assert.equal(ready.kind, 'ready')
    assert.equal(ready.body, null)
    assert.equal(ready.ready[0]?.name, 'Ostorosbor CRM')
  })

  await test('szójegyzék: álnév, OBSERVE, ref/val egymondatos magyar magyarázattal', () => {
    const byId = Object.fromEntries(PRIVACY_GLOSSARY.map((term) => [term.id, term]))
    assert.ok(byId.alias?.term.includes('Álnév'))
    assertNoJargonDump(byId.alias!.explanation)
    assert.ok(byId.observe?.term.includes('Megfigyelés'))
    assert.ok(byId.observe?.explanation.includes('valódi adat'))
    assert.ok(byId.ref?.term.toLowerCase().includes('hivatkozás'))
    assert.ok(byId.ref?.explanation.includes('forrás'))
    assert.ok(byId.val?.explanation.includes('titkosít'))
    for (const term of PRIVACY_GLOSSARY) {
      assertNoJargonDump(term.explanation)
    }
  })

  await test('mintaszűrő kategóriák külön vannak a tokenizálhatóktól', () => {
    assert.equal(isSensitivityScannerCategory('taj'), true)
    assert.equal(isSensitivityScannerCategory('adoszam'), true)
    assert.equal(isSensitivityScannerCategory('pan'), true)
    assert.equal(isSensitivityScannerCategory('iban'), true)
    assert.equal(isSensitivityScannerCategory('secret_key'), true)
    assert.equal(isSensitivityScannerCategory('company'), false)
    assert.equal(isSensitivityScannerCategory('email'), false)
    const byId = Object.fromEntries(PRIVACY_GLOSSARY.map((term) => [term.id, term]))
    assert.ok(byId.scanner?.term.includes('Mintaszűrő'))
    assert.ok(byId.scanner?.explanation.includes('Külön'))
  })

  await test('a két réteg introja külön témát ír, és a függetlenséget kimondja', () => {
    assert.ok(PRIVACY_PAGE_INTRO.includes('független'))
    assert.ok(PRIVACY_PAGE_INTRO.includes('nem nyúl a másikhoz'))
    assert.ok(PRIVACY_PAGE_INTRO.includes('katalógusa'))
    assert.ok(ALIAS_LAYER_INTRO.includes('TAJ'))
    assert.ok(ALIAS_LAYER_INTRO.includes('Kapcsolat'))
    assert.ok(SENSITIVITY_LAYER_INTRO.includes('független'))
    assert.ok(SENSITIVITY_LAYER_INTRO.includes('Nincs álnév'))
    assert.notEqual(PRIVACY_MODE_LABELS.enforce.label, SENSITIVITY_MODE_LABELS.enforce.label)
    assert.ok(PRIVACY_MODE_LABELS.enforce.label.includes('Álnév'))
    assert.ok(SENSITIVITY_MODE_LABELS.enforce.label.includes('Szigorú'))
  })

  await test('forrás-katalógus kategóriák nincsenek az alias szerkesztőben', () => {
    const rows = buildPrivacyPolicyEditorRows({ editingLayer: 'agent' })
    const visible = rows.filter((row) => isAliasPolicyEditorCategory(row.category))
    assert.equal(visible.some((row) => row.category === 'company'), false)
    assert.equal(visible.some((row) => row.category === 'person'), false)
    assert.equal(visible.some((row) => row.category === 'email'), true)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld')
}

void main()
