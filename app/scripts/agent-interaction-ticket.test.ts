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
 * A létrehozó ezen felül nem csak audit-mező: a `creator_or_operator` átmenet-szabály
 * (ticket-service) a `createdById`-nak JOGOT is ad a ticket állapotváltására. Ezért a
 * tenant-tag választása kötött rangsorban megy (admin → approver → operator → viewer),
 * különben egy viewer operátori jogot kapna erre a ticketre.
 *
 * T-1: a ticket tenantId-ja az AGENT tenantja (nem null).
 * T-2: null-tenant (platform) agentnél a tenantId null marad (nincs hamis tenant).
 * T-3: a létrehozó elsőként a tenant aktív ADMINJA.
 * T-4: admin híján a rangsor szerinti legmagasabb aktív tag (de sosem tenanton kívüli).
 * T-5: tag nélküli tenant → fail-closed (hiba, nem idegen admin).
 * T-6: platform-agentnél a globális rendszer-admin a tartalék.
 * T-7: platform-agent + nincs globális admin → fail-closed.
 * T-8: viewer CSAK akkor lehet létrehozó, ha nincs nála magasabb rangú aktív tag.
 */

import assert from 'node:assert/strict'
import {
  buildAgentInteractionTicketInput,
  resolveInteractionTicketCreatorId,
  TICKET_CREATOR_ROLE_PRECEDENCE,
  type TenantMemberFinder,
  type TicketCreatorRole,
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
const APPROVER_A = 'aaaaaaaa-0000-4000-8000-000000000a91'
const OPERATOR_A = 'aaaaaaaa-0000-4000-8000-000000000091'
const VIEWER_A = 'aaaaaaaa-0000-4000-8000-000000000e11'
const GLOBAL_ADMIN = 'ffffffff-0000-4000-8000-0000000000f1'

/** Konfigurálható tag-kereső: szerepenként adja vissza a tenant aktív tagját. */
function memberFinder(map: Partial<Record<TicketCreatorRole, string>>): TenantMemberFinder {
  return async ({ role }) => map[role] ?? null
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
      findTenantMember: memberFinder({
        admin: ADMIN_A,
        approver: APPROVER_A,
        operator: OPERATOR_A,
        viewer: VIEWER_A,
      }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(id, ADMIN_A)
  })

  await check('T-4: admin híján a rangsor szerinti legmagasabb aktív tag', async () => {
    const id = await resolveInteractionTicketCreatorId(TENANT_A, {
      findTenantMember: memberFinder({
        approver: APPROVER_A,
        operator: OPERATOR_A,
        viewer: VIEWER_A,
      }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(id, APPROVER_A)
  })

  await check('T-5: tag nélküli tenant → fail-closed (nem idegen admin)', async () => {
    await assert.rejects(
      () =>
        resolveInteractionTicketCreatorId(TENANT_A, {
          findTenantMember: memberFinder({}),
          // Ha ide visszaesne, cross-tenant attribúció lenne — a teszt bizonyítja, hogy NEM.
          findGlobalAdmin: async () => GLOBAL_ADMIN,
        }),
      /no active member/,
    )
  })

  await check('T-6: platform-agent → globális rendszer-admin a tartalék', async () => {
    const id = await resolveInteractionTicketCreatorId(null, {
      findTenantMember: memberFinder({}),
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

  await check('T-8: viewer csak akkor létrehozó, ha nincs magasabb rangú aktív tag', async () => {
    // A `creator_or_operator` szabály a létrehozónak állapotváltási jogot ad, ezért
    // viewer csak végső esetben kerülhet ide — operator jelenlétében sosem.
    const withOperator = await resolveInteractionTicketCreatorId(TENANT_A, {
      findTenantMember: memberFinder({ operator: OPERATOR_A, viewer: VIEWER_A }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(withOperator, OPERATOR_A)

    const viewerOnly = await resolveInteractionTicketCreatorId(TENANT_A, {
      findTenantMember: memberFinder({ viewer: VIEWER_A }),
      findGlobalAdmin: async () => GLOBAL_ADMIN,
    })
    assert.equal(viewerOnly, VIEWER_A)

    // A rangsor a UserRole enum csökkenő jogosultsági sorrendje — ha ez elcsúszik,
    // a fenti két elvárás közül az egyik némán megfordulna.
    assert.deepEqual(
      [...TICKET_CREATOR_ROLE_PRECEDENCE],
      ['admin', 'approver', 'operator', 'viewer'],
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
