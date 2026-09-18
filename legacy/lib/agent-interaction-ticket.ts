import type { Prisma } from '@prisma/client'

/**
 * Az agent REST API (`POST /api/v1/agent/tickets`) által létrehozott interakciós
 * ticket összeállításának TESZTELHETŐ magja. A route maga vékony adapter (nincs
 * saját HTTP-teszt), ezért a két tenant-invariánst itt, kiemelt egységként
 * rögzítjük — ugyanaz a minta, mint a webhook publikus-route allowlistjénél.
 *
 * Invariáns #1: a ticket tenantId-ja MINDIG az agent tenantja. Enélkül a ticket
 *   `tenantId = null`-lal jönne létre, és a tenant táblája (ami tenantId-re szűr)
 *   sosem mutatná — az agent emberi jóváhagyást/választ kérő interakciója némán
 *   elveszne.
 * Invariáns #2: a ticket „létrehozója" az agent SAJÁT tenantjának egy tagja, sosem
 *   egy globális, akár másik tenanthoz tartozó admin (cross-tenant attribúció).
 * Invariáns #3: a létrehozó a tenant LEGMAGASABB rangú aktív tagja. A `createdById`
 *   nem csupán audit-mező: a `creator_or_operator` átmenet-szabály jogot is ad
 *   neki a ticket állapotváltására. Egy tetszőlegesen kiválasztott tag (pl. egy
 *   viewer) így operátori jogot kapna erre a ticketre — ezért a rangsor kötött.
 */

/**
 * A létrehozó-választás rangsora (a `UserRole` enum szerinti csökkenő jogosultság).
 * Explicit lista, nem DB-oldali enum-rendezés: így a döntés itt, tesztelhetően él.
 */
export const TICKET_CREATOR_ROLE_PRECEDENCE = ['admin', 'approver', 'operator', 'viewer'] as const

export type TicketCreatorRole = (typeof TICKET_CREATOR_ROLE_PRECEDENCE)[number]

export type TenantMemberFinder = (args: {
  tenantId: string
  role: TicketCreatorRole
}) => Promise<string | null>

export type GlobalAdminFinder = () => Promise<string | null>

/**
 * A létrehozó user feloldása fail-closed módon az agent tenantjában: a
 * `TICKET_CREATOR_ROLE_PRECEDENCE` sorrendjében az első aktív tag. Platform-szintű
 * (tenant nélküli) agentnél nincs tenant-board, ezért ott a globális rendszer-admin
 * a végső tartalék. Ha egy tenanthoz egyetlen aktív tag sincs, inkább hibázunk,
 * mintsem idegen tenant adminját tüntessük fel létrehozóként.
 */
export async function resolveInteractionTicketCreatorId(
  tenantId: string | null,
  ports: { findTenantMember: TenantMemberFinder; findGlobalAdmin: GlobalAdminFinder },
): Promise<string> {
  if (tenantId) {
    for (const role of TICKET_CREATOR_ROLE_PRECEDENCE) {
      const member = await ports.findTenantMember({ tenantId, role })
      if (member) return member
    }
    // A hibaüzenet a gép-gép REST API válaszába kerül, ezért — a route többi
    // hibájával egyezően — angol.
    throw new Error('Tenant has no active member to attribute the ticket to')
  }
  const globalAdmin = await ports.findGlobalAdmin()
  if (!globalAdmin) throw new Error('No system user configured')
  return globalAdmin
}

export type AgentInteractionTicketInput = {
  tenantId: string | null
  type: 'interaction'
  title: string
  state: 'in_progress'
  assigneeType: 'human'
  assigneeId: null
  agentId: string
  payload: Prisma.JsonValue
  sourceDocumentId: string | null
  executeAfter: null
  dueBy: null
  createdById: string
}

/**
 * Az interakciós ticket create-inputja. A tenantId MINDIG az agent tenantjából
 * származik — nincs csendes visszaesés „platform" (null tenant) ticketre.
 */
export function buildAgentInteractionTicketInput(params: {
  agent: { id: string; tenantId: string | null }
  data: { title: string; payload: Record<string, unknown>; sourceDocumentId?: string }
  createdById: string
}): AgentInteractionTicketInput {
  return {
    tenantId: params.agent.tenantId,
    type: 'interaction',
    title: params.data.title,
    state: 'in_progress',
    assigneeType: 'human',
    assigneeId: null,
    agentId: params.agent.id,
    payload: params.data.payload as Prisma.JsonValue,
    sourceDocumentId: params.data.sourceDocumentId ?? null,
    executeAfter: null,
    dueBy: null,
    createdById: params.createdById,
  }
}
