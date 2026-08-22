/**
 * APG-11 — Kategória-policy: allow | tokenize | local_only | block,
 * hierarchia, kemény invariánsok, a mai kapcsoló migrációja.
 *
 * DoD: a ma allowSensitiveExternalModel=true agentek viselkedése nem változik;
 * secret_key: tokenize mentése elbukik; pan: allow megerősítés nélkül elbukik (#320 D9).
 *
 * Futtatás: npm run test:privacy-category-policy
 */
import assert from 'node:assert/strict'

import { PlatformSettingsService } from '../src/domain/platform-settings/platform-settings-service'
import {
  actionForPrivacyCategory,
  allowsExternalRaw,
  assertPrivacyCategoryPolicyPatch,
  DEFAULT_PRIVACY_CATEGORY_POLICY,
  PAN_IBAN_ALLOW_CONFIRMATION,
  PrivacyCategoryPolicyError,
  resolvePrivacyCategoryPolicy,
  type PrivacyCategoryPolicyActor,
} from '../src/domain/privacy/privacy-category-policy'
import type { AuditRepository, PlatformSettingsRepository } from '../src/repositories/interfaces'

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

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const AGENT = 'bbbbbbbb-0000-4000-8000-000000000002'

// #320 D9 óta a mentés-szintű kapu csak a gépelt megerősítés; a superadmin-jog
// megszűnt, ezért a teszt-aktorok sem hordoznak `isSuperadmin`-t.
const WITH_CONFIRMATION: PrivacyCategoryPolicyActor = {
  actorId: 'super-1',
  confirmation: PAN_IBAN_ALLOW_CONFIRMATION,
}

const TENANT_ADMIN: PrivacyCategoryPolicyActor = {
  actorId: 'admin-1',
}

function inMemorySettings() {
  const store = new Map<string, unknown>()
  const events: Record<string, unknown>[] = []
  const settingsRepo: PlatformSettingsRepository = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value)
    },
  }
  const auditRepo = {
    append: async (event: Record<string, unknown>) => {
      events.push(event)
      return event
    },
  } as unknown as AuditRepository
  return { svc: new PlatformSettingsService(settingsRepo, auditRepo), events, store }
}

async function main() {
  console.log('APG-11 kategória-policy, invariánsok és kapcsoló-migráció\n')

  await test('alapértelmezés: sensitive → local_only, forbidden → block, surrogate → tokenize', () => {
    const resolved = resolvePrivacyCategoryPolicy({})
    assert.equal(resolved.categories.email, 'local_only')
    assert.equal(resolved.categories.taj, 'local_only')
    assert.equal(resolved.categories.adoszam, 'local_only')
    assert.equal(resolved.categories.pan, 'block')
    assert.equal(resolved.categories.iban, 'block')
    assert.equal(resolved.categories.secret_key, 'block')
    assert.equal(resolved.categories.company, 'tokenize')
    assert.equal(resolved.legacyToggleApplied, false)
    assert.deepEqual(resolved.categories.email, DEFAULT_PRIVACY_CATEGORY_POLICY.email)
  })

  await test('hierarchia: platform → tenant → agent, a későbbi kulcs győz', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      platform: {
        patternSetVersion: 2,
        categories: { email: 'tokenize', taj: 'block' },
        custom: { employee_id: 'tokenize' },
        updatedById: null,
        updatedAt: null,
      },
      tenant: {
        categories: { email: 'local_only' },
        custom: { employee_id: 'block', badge: 'tokenize' },
        updatedById: null,
        updatedAt: null,
      },
      agent: {
        categories: { email: 'allow' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
    })
    assert.equal(resolved.categories.email, 'allow')
    assert.equal(resolved.categories.taj, 'block')
    assert.equal(resolved.categories.pan, 'block')
    assert.equal(resolved.custom.employee_id, 'block')
    assert.equal(resolved.custom.badge, 'tokenize')
    assert.equal(resolved.patternSetVersion, 2)
  })

  await test('card_broad a pan policyjét örökli', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      platform: {
        patternSetVersion: 1,
        categories: { pan: 'local_only' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
    })
    assert.equal(actionForPrivacyCategory(resolved, 'card_broad'), 'local_only')
    assert.equal(actionForPrivacyCategory(resolved, 'pan'), 'local_only')
    assert.equal(actionForPrivacyCategory(resolved, 'unknown_custom'), 'tokenize')
  })

  await test('secret_key: tokenize mentése elbukik', () => {
    assert.throws(
      () =>
        assertPrivacyCategoryPolicyPatch({ categories: { secret_key: 'tokenize' } }, TENANT_ADMIN),
      (err: unknown) =>
        err instanceof PrivacyCategoryPolicyError && err.code === 'secret_key_not_block',
    )
    assert.throws(
      () => assertPrivacyCategoryPolicyPatch({ categories: { secret_key: 'allow' } }, WITH_CONFIRMATION),
      (err: unknown) =>
        err instanceof PrivacyCategoryPolicyError && err.code === 'secret_key_not_block',
    )
  })

  await test('pan: allow tenant adminnál megerősítéssel átmegy (#320 D9)', () => {
    assertPrivacyCategoryPolicyPatch(
      { categories: { pan: 'allow' } },
      { ...TENANT_ADMIN, confirmation: PAN_IBAN_ALLOW_CONFIRMATION },
    )
  })

  await test('pan: allow megerősítés nélkül elbukik', () => {
    assert.throws(
      () =>
        assertPrivacyCategoryPolicyPatch(
          { categories: { pan: 'allow' } },
          {},
        ),
      (err: unknown) =>
        err instanceof PrivacyCategoryPolicyError && err.code === 'allow_confirmation_required',
    )
  })

  await test('pan/iban allow ALLOW_PAN_IBAN megerősítéssel átmegy', () => {
    assertPrivacyCategoryPolicyPatch(
      { categories: { pan: 'allow', iban: 'allow', email: 'tokenize' } },
      WITH_CONFIRMATION,
    )
  })

  await test('migráció: allowSensitiveExternalModel=true viselkedése nem változik', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      legacyAllowSensitiveExternalModel: true,
    })
    assert.equal(resolved.legacyToggleApplied, true)
    // Mai kapcsoló: sensitive ÉS forbidden is kimehet külső modellre.
    assert.equal(resolved.categories.email, 'allow')
    assert.equal(resolved.categories.taj, 'allow')
    assert.equal(resolved.categories.adoszam, 'allow')
    assert.equal(resolved.categories.pan, 'allow')
    assert.equal(resolved.categories.iban, 'allow')
    assert.equal(resolved.categories.secret_key, 'allow')
    assert.equal(allowsExternalRaw(resolved.categories.email), true)
    assert.equal(allowsExternalRaw(resolved.categories.pan), true)
  })

  await test('migráció: a kapcsoló false mellett a default policy él', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      legacyAllowSensitiveExternalModel: false,
    })
    assert.equal(resolved.legacyToggleApplied, false)
    assert.equal(resolved.categories.email, 'local_only')
    assert.equal(resolved.categories.pan, 'block')
    assert.equal(allowsExternalRaw(resolved.categories.email), false)
    assert.equal(allowsExternalRaw(resolved.categories.pan), false)
  })

  await test('explicit agent overlay elnyomja a legacy kapcsolót', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      legacyAllowSensitiveExternalModel: true,
      agent: {
        categories: { email: 'tokenize' },
        custom: {},
        updatedById: null,
        updatedAt: null,
      },
    })
    assert.equal(resolved.legacyToggleApplied, false)
    assert.equal(resolved.categories.email, 'tokenize')
    assert.equal(resolved.categories.pan, 'block', 'a kapcsoló pan-allow overlaye nem él explicit policy mellett')
  })

  await test('PlatformSetting roundtrip + mintakészlet-verzió audit', async () => {
    const { svc, events } = inMemorySettings()
    const first = await svc.resolvePrivacyCategoryPolicy({
      tenantId: TENANT,
      agentId: AGENT,
      legacyAllowSensitiveExternalModel: true,
    })
    assert.equal(first.categories.email, 'allow')
    assert.equal(first.categories.pan, 'allow')

    await svc.setPrivacyCategoryPolicy({ categories: { email: 'tokenize' } }, TENANT_ADMIN)
    const afterPlatform = await svc.resolvePrivacyCategoryPolicy({
      tenantId: TENANT,
      agentId: AGENT,
      legacyAllowSensitiveExternalModel: true,
    })
    assert.equal(afterPlatform.categories.email, 'allow', 'legacy agent-toggle még felülírja a platform tokenize-t')
    assert.equal(afterPlatform.patternSetVersion, 2)

    await svc.setAgentPrivacyCategoryPolicy(
      AGENT,
      { categories: { email: 'local_only' } },
      TENANT_ADMIN,
    )
    const afterAgent = await svc.resolvePrivacyCategoryPolicy({
      tenantId: TENANT,
      agentId: AGENT,
      legacyAllowSensitiveExternalModel: true,
    })
    assert.equal(afterAgent.legacyToggleApplied, false)
    assert.equal(afterAgent.categories.email, 'local_only')
    assert.equal(afterAgent.categories.pan, 'block')

    await assert.rejects(
      () => svc.setPrivacyCategoryPolicy({ categories: { secret_key: 'tokenize' } }, TENANT_ADMIN),
      (err: unknown) =>
        err instanceof PrivacyCategoryPolicyError && err.code === 'secret_key_not_block',
    )
    await assert.rejects(
      () => svc.setPrivacyCategoryPolicy({ categories: { pan: 'allow' } }, TENANT_ADMIN),
      (err: unknown) =>
        err instanceof PrivacyCategoryPolicyError && err.code === 'allow_confirmation_required',
    )

    await svc.setPrivacyCategoryPolicy(
      { categories: { pan: 'allow' } },
      { ...TENANT_ADMIN, confirmation: PAN_IBAN_ALLOW_CONFIRMATION },
    )
    const panAllowed = await svc.resolvePrivacyCategoryPolicy({ tenantId: TENANT })
    assert.equal(panAllowed.categories.pan, 'allow')

    const policyEvents = events.filter((e) => e.action === 'privacy.gateway.category_policy.set')
    assert.equal(policyEvents.length >= 3, true)
    assert.equal(
      policyEvents.some((e) => (e.metadata as { patternSetVersion?: number }).patternSetVersion === 2),
      true,
    )
  })

  await test('audit: a policy-esemény rögzíti a megválasztott akciót és a nyers-egress bekapcsolását', async () => {
    const { svc, events } = inMemorySettings()

    // (1) Szigorítás: pan block marad → nincs nyers-egress jelzés.
    await svc.setTenantPrivacyCategoryPolicy(
      TENANT,
      { categories: { phone: 'local_only' } },
      TENANT_ADMIN,
    )
    // (2) Nyers PAN kiengedése külső modellre (tenant-admin + megerősítés, #320 D9).
    await svc.setTenantPrivacyCategoryPolicy(
      TENANT,
      { categories: { pan: 'allow' } },
      { ...TENANT_ADMIN, confirmation: PAN_IBAN_ALLOW_CONFIRMATION },
    )

    const setEvents = events.filter((e) => e.action === 'privacy.gateway.category_policy.set')
    assert.equal(setEvents.length, 2)

    const tighten = setEvents[0]!
    assert.deepEqual((tighten.metadata as { actions: unknown }).actions, { phone: 'local_only' })
    assert.deepEqual((tighten.metadata as { rawEgressEnabled: unknown }).rawEgressEnabled, [])
    assert.equal(tighten.policyDecision, 'category_policy')

    const rawEgress = setEvents[1]!
    assert.deepEqual((rawEgress.metadata as { actions: unknown }).actions, { pan: 'allow' })
    assert.deepEqual((rawEgress.metadata as { rawEgressEnabled: unknown }).rawEgressEnabled, ['pan'])
    // Külön policyDecision → SIEM/megfelelőség szűrni tud a nyers kiengedésre.
    assert.equal(rawEgress.policyDecision, 'category_policy_raw_egress')
    assert.equal(rawEgress.tenantId, TENANT)
  })

  await test('audit: a null overlay (öröklésre visszaállítás) `inherit`-ként naplózódik', async () => {
    const { svc, events } = inMemorySettings()
    await svc.setAgentPrivacyCategoryPolicy(AGENT, { categories: { email: null } }, TENANT_ADMIN)
    const setEvent = events.find((e) => e.action === 'privacy.gateway.category_policy.set')!
    assert.deepEqual((setEvent.metadata as { actions: unknown }).actions, { email: 'inherit' })
    assert.deepEqual((setEvent.metadata as { rawEgressEnabled: unknown }).rawEgressEnabled, [])
  })

  await test('tenant-egyedi minta overlay', async () => {
    const { svc } = inMemorySettings()
    await svc.setTenantPrivacyCategoryPolicy(
      TENANT,
      { custom: { employee_id: 'tokenize' } },
      TENANT_ADMIN,
    )
    const resolved = await svc.resolvePrivacyCategoryPolicy({ tenantId: TENANT })
    assert.equal(actionForPrivacyCategory(resolved, 'employee_id'), 'tokenize')
  })

  await test('null overlay visszaállítja az öröklést', async () => {
    const { svc } = inMemorySettings()
    await svc.setTenantPrivacyCategoryPolicy(
      TENANT,
      { categories: { email: 'tokenize' } },
      TENANT_ADMIN,
    )
    const overlaid = await svc.resolvePrivacyCategoryPolicy({ tenantId: TENANT })
    assert.equal(overlaid.categories.email, 'tokenize')

    await svc.setTenantPrivacyCategoryPolicy(
      TENANT,
      { categories: { email: null } },
      TENANT_ADMIN,
    )
    const inherited = await svc.resolvePrivacyCategoryPolicy({ tenantId: TENANT })
    assert.equal(inherited.categories.email, DEFAULT_PRIVACY_CATEGORY_POLICY.email)
    const layer = await svc.getTenantPrivacyCategoryPolicy(TENANT)
    assert.equal('email' in layer.categories, false)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld')
}

void main()
