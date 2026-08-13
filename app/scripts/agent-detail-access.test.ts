/**
 * Agent-detail feloldás: 404 vs. rossz tenant vs. loader-hiba.
 *
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/agent-detail-access.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentDetailLoadError,
  classifyAgentDetailLookup,
} from '../src/lib/agent-detail-access'
import { resolveActiveTenant, type MembershipView } from '../src/lib/tenant-policy'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const M = (over: Partial<MembershipView> & { tenantId: string }): MembershipView => ({
  role: 'admin',
  status: 'active',
  isDefault: false,
  ...over,
})

const KATI = {
  id: '2b3a1502-aafa-4fb9-a5df-d3be3290c3c9',
  name: 'Kati',
  tenantId: 'ca8ac509-2d68-4a62-9c71-c66bfc6f6b5b',
}
const DEMO = '00000000-0000-4000-a000-000000000001'
const POS = KATI.tenantId

check('ugyanabban a tenantban megvan → found', () => {
  const d = classifyAgentDetailLookup({
    displayed: { tenantId: POS },
    unrestricted: KATI,
    activeTenantId: POS,
    membershipTenantIds: new Set([POS, DEMO]),
  })
  assert.equal(d.status, 'found')
})

check('másik saját tenantban van → wrong_tenant, nem 404', () => {
  const d = classifyAgentDetailLookup({
    displayed: null,
    unrestricted: KATI,
    activeTenantId: DEMO,
    membershipTenantIds: new Set([POS, DEMO]),
  })
  assert.equal(d.status, 'wrong_tenant')
  if (d.status === 'wrong_tenant') {
    assert.equal(d.agentTenantId, POS)
    assert.equal(d.agentName, 'Kati')
  }
})

check('idegen tenant agentje → not_found (nem szivárog)', () => {
  const d = classifyAgentDetailLookup({
    displayed: null,
    unrestricted: { ...KATI, tenantId: 'other-tenant' },
    activeTenantId: DEMO,
    membershipTenantIds: new Set([DEMO]),
  })
  assert.equal(d.status, 'not_found')
})

check('nincs ilyen agent → not_found', () => {
  const d = classifyAgentDetailLookup({
    displayed: null,
    unrestricted: null,
    activeTenantId: POS,
    membershipTenantIds: new Set([POS]),
  })
  assert.equal(d.status, 'not_found')
})

check('wrong_tenant hiba kódja nem NOT_FOUND', () => {
  const err = AgentDetailLoadError.wrongTenant(POS, 'Kati')
  assert.equal(err.code, 'WRONG_TENANT')
  assert.notEqual(err.code, 'NOT_FOUND')
  assert.equal(err.meta.agentName, 'Kati')
})

check('több isDefault esetén a lista UTOLSÓ defaultja (a frissebb tagság)', () => {
  const r = resolveActiveTenant({
    memberships: [
      M({ tenantId: DEMO, isDefault: true }),
      M({ tenantId: 'ostorosbor' }),
      M({ tenantId: POS, isDefault: true }),
    ],
    platformRoles: [],
  })
  assert.equal(r.kind, 'tenant')
  if (r.kind === 'tenant') assert.equal(r.tenantId, POS)
})

check('explicit cookie továbbra is megelőzi a defaultot', () => {
  const r = resolveActiveTenant({
    memberships: [
      M({ tenantId: DEMO, isDefault: true }),
      M({ tenantId: POS, isDefault: true }),
    ],
    platformRoles: [],
    requestedTenantId: POS,
  })
  assert.equal(r.kind, 'tenant')
  if (r.kind === 'tenant') assert.equal(r.tenantId, POS)
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pageSrc = readFileSync(join(root, 'src/app/control-plane/agents/[agentId]/page.tsx'), 'utf8')

check('a detail oldal nem nyeli 404-be a loader minden hibáját', () => {
  assert.doesNotMatch(
    pageSrc,
    /if\s*\(\s*!res\.success\s*\)\s*notFound\s*\(\s*\)/,
    'a régi if (!res.success) notFound() kapu bent maradt',
  )
  assert.match(pageSrc, /AgentDetailUnavailable|wrong_tenant|LOAD_FAILED/)
  assert.match(pageSrc, /loadAgentDetailPageData/)
  assert.doesNotMatch(pageSrc, /getAgentDetailPageData/)
})

check('a control-plane szegmensnek van saját 404 oldala (fejléc megmarad)', () => {
  const notFoundSrc = readFileSync(join(root, 'src/app/control-plane/not-found.tsx'), 'utf8')
  assert.match(notFoundSrc, /tenant/i)
})

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('OK — agent detail access (9 checks)')
