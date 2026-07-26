/**
 * Agent REST API — interakciós ticket tenant-invariánsai.
 *
 * Futtatás: npx tsx scripts/agent-interaction-ticket.test.ts
 *
 * A `POST /api/v1/agent/tickets` route eddig tenantId NÉLKÜL (null) hozta létre az
 * agent interakciós ticketjét, és egy GLOBÁLIS, legrégebbi admint tüntetett fel
 * létrehozóként — függetlenül attól, melyik tenanthoz tartozik az agent. Két baj:
 *   (1) a tenant táblája tenantId-re szűr, ezért a null-tenant ticket SOSEM jelent
 *       meg — az agent emberi választ kérő interakciója némán elveszett;
 *   (2) a ticket „létrehozója" egy másik tenant adminja lehetett (cross-tenant
 *       attribúció az audit-nyomban).
 *
 * T-1: a ticket tenantId-ja az AGENT tenantja (nem null).
 * T-2: null-tenant (platform) agentnél a tenantId null marad (nincs hamis tenant).
 * T-3: a létrehozó elsőként a tenant aktív ADMINJA.
 * T-4: admin híján a tenant bármely aktív TAGJA a létrehozó (de sosem tenanton kívüli).
 * T-5: tag nélküli tenant → fail-closed (hiba, nem idegen admin).
 * T-6: platform-agentnél a globális rendszer-admin a tartalék.
 * T-7: platform-agent + nincs globális admin → fail-closed.
 */

import assert from 'node:assert/strict'
import {
  buildAgentInteractionTicketInput,
  resolveInteractionTicketCreatorId,
  type TenantMemberFinder,
} from '../src/lib/agent-interaction-ticket'

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

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ADMIN_A = 'aaaaaaaa-0000-4000-8000-000000000ad1'
const MEMBER_A = 'aaaaaaaa-0000-4000-8000-000000000e11'
const GLOBAL_ADMIN = 'ffffffff-0000-4000-8000-0000000000f1'

/** Konfigurálható tag-kereső: külön válasz admin-only és bármely-tag lekérdezésre. */
function memberFinder(map: { admin?: string | null; any?: string | null }): TenantMemberFinder {
  return async ({ adminOnly }) => (adminOnly ? (map.admin ?? null) : (map.any ?? null))
}

async function main() {
  await check('T-1: a ticket tenantId-ja az agent tenantja', () => {
    const input = buildAgentInteractionTicketInput({
      agent: { id: 'agent-1', tenantId: TENANT_A },
      data: { title: 'Kérdés', payload: { q: 1 } },
      createdById: ADMIN_A,
    })
    assert.equal(input.tenantId, TENANT_A)
    assert.equal(input.type, 'interaction')
    assert.equal(input.assigneeType, 'human')
    assert.equal(input.createdById, ADMIN_A)
  })

  await check('T-2: platform-agent → tenantId null (nincs hamis tenant)', () => {
    const input = buildAgentInteractionTicketInput({
      agent: { id: 'agent-plat', tenantId: null },
      data: { title: 'x', payload: {} },
      createdById: GLOBAL_ADMIN,
    })
    assert.equal(input.tenantId, null)
  })

  await check('T-3: a létrehozó a tenant aktív adminja', async () => {
    const id = await resolveInteractionTicketCreatorId(TENANT_A, {
      findTenantMember: memberFinder({ admin: ADMIN_A, any: MEMBER_A }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(id, ADMIN_A)
  })

  await check('T-4: admin híján a tenant bármely aktív tagja', async () => {
    const id = await resolveInteractionTicketCreatorId(TENANT_A, {
      findTenantMember: memberFinder({ admin: null, any: MEMBER_A }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(id, MEMBER_A)
  })

  await check('T-5: tag nélküli tenant → fail-closed (nem idegen admin)', async () => {
    await assert.rejects(
      () =>
        resolveInteractionTicketCreatorId(TENANT_A, {
          findTenantMember: memberFinder({ admin: null, any: null }),
          // Ha ide visszaesne, cross-tenant attribúció lenne — a teszt bizonyítja, hogy NEM.
          findGlobalAdmin: async () => GLOBAL_ADMIN,
        }),
      /nincs aktív tagja/,
    )
  })

  await check('T-6: platform-agent → globális rendszer-admin a tartalék', async () => {
    const id = await resolveInteractionTicketCreatorId(null, {
      findTenantMember: memberFinder({ admin: null, any: null }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(id, GLOBAL_ADMIN)
  })

  await check('T-7: platform-agent + nincs globális admin → fail-closed', async () => {
    await assert.rejects(
      () =>
        resolveInteractionTicketCreatorId(null, {
          findTenantMember: memberFinder({}),
          findGlobalAdmin: async () => null,
        }),
      /No system user configured/,
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
