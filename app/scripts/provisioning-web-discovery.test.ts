/**
 * Provisioning Web-Discovery (WD-*) — a felfedezés determinisztikus kapui
 * (Feature-spec — WebFetch-Egress §13.2). Fakes-szel, DB nélkül.
 *
 * A felfedező hurok (ProvisioningAssistant) és a web-egress role a Phase 0 óta a `legacy/` fában
 * él, ezért itt csak az aktív kapu maradt: a determinisztikus validátor, ami a
 * mérgezett forrásból jött config-jelöltet `failed`-del elkaszálja.
 */
import assert from 'node:assert/strict'
import { validateDraftConfig } from '../src/domain/provisioning/draft-validator'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'Stripe',
    baseUrl: 'https://api.stripe.com',
    egressHosts: ['api.stripe.com'],
    authMode: 'service',
    auth: { type: 'bearer_token', secretAliasSuggested: 'STRIPE_KEY' },
    scopesSuggested: ['charges:read'],
    proposedTools: [{ name: 'get_charge', method: 'GET', path: '/v1/charges/{id}', access: 'read' }],
    ...overrides,
  }
}

async function main() {
  await test('WD-N4 banki preset: ismeretlen egress-host → validátor FAILED (nem warned)', async () => {
    const cfg = validConfig({ provider: 'NewAPI', baseUrl: 'https://api.newapi.com', egressHosts: ['api.newapi.com'] })
    const v = validateDraftConfig(cfg as never, { egressAllowlist: [], bankPreset: true })
    assert.equal(v.status, 'failed')
    assert.ok(v.errors.some((e) => e.includes('egress_host_not_allowlisted')))
  })

  await test('WD-N5 inline-secret a forrásból → validátor FAILED, a kulcs nem szivárog', async () => {
    // A modell (bedőlve) valódi kulcsot pakol a config egy string-mezőjébe.
    const cfg = validConfig({
      proposedTools: [{ name: 'get', method: 'GET', path: '/v1/x', access: 'read', description: 'Auth: bearer abcdefghijklmnop1234' }],
    })
    const v = validateDraftConfig(cfg as never, { egressAllowlist: ['api.stripe.com'] })
    assert.equal(v.status, 'failed')
    assert.ok(v.errors.some((e) => e.includes('inline_secret_detected')))
    // Az errors a minta NEVÉT tartalmazza, nem a nyers kulcsot.
    assert.ok(!JSON.stringify(v.errors).includes('abcdefghijklmnop'))
  })

  if (failures > 0) {
    console.error(`\n${failures} web-discovery teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden web-discovery teszt zöld.')
}

main()
