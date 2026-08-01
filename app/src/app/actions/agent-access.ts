'use server'

/**
 * Server actionök az agent-hozzáférési gráf admin felületéhez (issue #142).
 *
 * ÜZLETI JELENTÉS: ez a „ki kivel beszélhet" szerkesztő. A felhasználónak NEM kell
 * ismernie a `view` / `address` / inbound / outbound / principal szakkifejezéseket —
 * a UI hétköznapi magyar szöveggel dolgozik, ezek az actionök viszont a pontos
 * policy-fogalmakat adják vissza, hogy a megjelenítés egyértelmű maradhasson.
 *
 * MINDEN írás tenant admin jog (a superadmin csak assume-tenant kontextusban, a
 * tenant nevében), és MINDEN írás auditált — a grant-sor és az audit-esemény
 * ugyanabban a tranzakcióban keletkezik.
 */
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { isTenantAdmin, tenantUserSubject } from '@/domain/agent-access/tenant-user-subject'
import { isAdminOnlyGraphNode } from '@/lib/platform-agent-registry'
import { personaFor } from '@/lib/agent-persona'

const uuid = z.string().uuid()

const setGrantSchema = z.object({
  subjectKind: z.enum(['user', 'agent']),
  subjectId: uuid,
  targetAgentId: uuid,
  canView: z.boolean(),
  canAddress: z.boolean(),
})

const restrictionSchema = z.object({
  agentId: uuid,
  inboundRestricted: z.boolean().optional(),
  outboundRestricted: z.boolean().optional(),
})

const coneSchema = z.object({
  subjectKind: z.enum(['user', 'agent']),
  subjectId: uuid,
})

/**
 * Az org-ábra teljes gráfmásolata: agent-csomópontok, user-sáv és a meglévő élek.
 * A kliens EZEN futtatja ugyanazt a tiszta reachability-algoritmust, amit a szerver —
 * nincs cache-tábla és nincs két külön implementáció, ami elcsúszhatna.
 */
export async function loadAgentAccessGraph() {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    if (!tenantId) return fail('Nincs aktív szervezet.')

    const [graph, memberships] = await Promise.all([
      services.agentAccess.loadTenantGraph(tenantId),
      prisma.tenantMembership.findMany({
        where: { tenantId, status: 'active', user: { status: 'active' } },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { user: { name: 'asc' } },
      }),
    ])

    return ok({
      // Management felületként MINDEN tenant-gráfcsomópont látszik — a rejtett és a
      // csak-admin (Web-Egress) csomópontok is. A rejtés listázási szabály, nem
      // hozzáférési él, ezért az org-ábrán nem szabad eltakarnia a valós policy-t.
      agents: graph.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        nickname: personaFor(node.name, node).nickname,
        role: node.role,
        status: node.status,
        hiddenFromOperators: node.hiddenFromOperators,
        inboundRestricted: node.inboundRestricted,
        outboundRestricted: node.outboundRestricted,
        adminOnly: isAdminOnlyGraphNode(node),
      })),
      users: memberships.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
      })),
      grants: graph.grants,
      /**
       * Ha a tenantban egyetlen korlátozás sincs bekapcsolva, az implicit élek száma
       * N² — ezt értelmetlen kirajzolni. A UI helyette őszinte bannert mutat.
       */
      fullyDefaultOpen: graph.fullyDefaultOpen,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a kapcsolati ábrát')
  }
}

/**
 * Egy él létrehozása / bővítése / szűkítése. Mindkét ige levétele a SOR TÖRLÉSÉT
 * jelenti — a UI-ban ez a „mindkét sáv lekerül" művelet.
 */
export async function setAgentAccessGrant(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    if (!tenantId) return fail('Nincs aktív szervezet.')
    const parsed = setGrantSchema.parse(input)

    const result = await services.agentAccess.setGrant({
      tenantId,
      subject:
        parsed.subjectKind === 'user'
          ? { kind: 'user', userId: parsed.subjectId }
          : { kind: 'agent', agentId: parsed.subjectId },
      targetAgentId: parsed.targetAgentId,
      canView: parsed.canView,
      canAddress: parsed.canAddress,
      actorUserId: user.user.id,
    })

    if (!result.ok) return fail(grantFailureMessage(result.reason))
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a kapcsolatot')
  }
}

/**
 * A szigorítás KÖTELEZŐ előnézete. Megmutatja, mely ma működő kapcsolatok szűnnek
 * meg, mely élő chat/ticket utakat érint, és mekkora lesz utána az elérhetőségi kúp.
 * Ez az a kapu, ami megakadályozza, hogy egy jószándékú szigorítás észrevétlenül
 * elvágjon élő munkafolyamatokat.
 */
export async function previewAgentAccessRestriction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    if (!tenantId) return fail('Nincs aktív szervezet.')
    const parsed = restrictionSchema.parse(input)

    const preview = await services.agentAccess.previewRestrictionChange({
      tenantId,
      agentId: parsed.agentId,
      inboundRestricted: parsed.inboundRestricted,
      outboundRestricted: parsed.outboundRestricted,
      activePathReader: (agentId) => listActivePathsForAgent(tenantId, agentId),
    })

    if ('ok' in preview && preview.ok === false) return fail(grantFailureMessage(preview.reason))
    return ok(preview)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült elkészíteni az előnézetet')
  }
}

/**
 * A kapcsoló tényleges átállítása. A UI-ban CSAK a dry-run megerősítése után hívható —
 * a `confirmedPreview` flag ezt teszi szerződéssé a szerveroldalon is: megerősítés
 * nélkül nem kapcsolható be korlátozás.
 */
export async function setAgentAccessRestriction(
  input: unknown,
): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    if (!tenantId) return fail('Nincs aktív szervezet.')
    const parsed = restrictionSchema.extend({ confirmedPreview: z.boolean() }).parse(input)

    // Szigorításnál (bármelyik kapcsoló BE) kötelező a megerősített előnézet.
    const isTightening = parsed.inboundRestricted === true || parsed.outboundRestricted === true
    if (isTightening && !parsed.confirmedPreview) {
      return fail(
        'A korlátozás bekapcsolása előtt meg kell nézni és jóvá kell hagyni a hatás-előnézetet.',
      )
    }

    const result = await services.agentAccess.setRestrictions({
      tenantId,
      agentId: parsed.agentId,
      inboundRestricted: parsed.inboundRestricted,
      outboundRestricted: parsed.outboundRestricted,
      actorUserId: user.user.id,
    })
    if (!result.ok) return fail(grantFailureMessage(result.reason))
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült módosítani a korlátozást')
  }
}

/**
 * Egy alany tranzitív elérhetőségi kúpja. Ez mutatja meg, hogy egy jog VALÓJÁBAN
 * mekkora hálózatra terjed ki: az agent önálló principal, ezért egy user→A jog A
 * teljes elérhetőségi kúpjára ad hozzáférést.
 */
export async function loadAgentAccessCone(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    if (!tenantId) return fail('Nincs aktív szervezet.')
    const parsed = coneSchema.parse(input)

    const cone = await services.agentAccess.reachabilityCone(
      parsed.subjectKind === 'user'
        ? { kind: 'user', userId: parsed.subjectId, tenantId }
        : { kind: 'agent', agentId: parsed.subjectId, tenantId },
      { includeAdminOnly: true, subjectIsTenantAdmin: isTenantAdmin(user) },
    )
    return ok(cone)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült kiszámolni az elérhetőségi kört')
  }
}

/**
 * A saját (bejelentkezett) felhasználó elérhetőségi köre — a nem-admin felületek
 * „mihez van jogom?" magyarázó dobozához. Nem igényel admin jogot.
 */
export async function loadMyAgentAccessCone() {
  try {
    const user = await requireTenantRole('viewer')
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Nincs aktív szervezet.')
    const cone = await services.agentAccess.reachabilityCone(subject, {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    return ok(cone)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült kiszámolni az elérhetőségi kört')
  }
}

/**
 * A szigorítás által érintett ÉLŐ utak: nyitott beszélgetések és le nem zárt ticketek
 * az agenttel. Ez teszi konkréttá a dry-run figyelmeztetést („3 futó beszélgetést vág el").
 */
async function listActivePathsForAgent(
  tenantId: string,
  agentId: string,
): Promise<Array<{ kind: 'conversation' | 'ticket'; id: string; label: string }>> {
  const [conversations, tickets] = await Promise.all([
    prisma.conversation.findMany({
      where: { tenantId, agentId, status: 'active' },
      select: { id: true, title: true },
      take: 25,
      orderBy: { updatedAt: 'desc' },
    }),
    repositories.tickets.findMany({
      tenantId,
      state: ['backlog', 'ready', 'approved', 'in_progress', 'awaiting_human'],
      limit: 25,
    }),
  ])

  return [
    ...conversations.map((c) => ({
      kind: 'conversation' as const,
      id: c.id,
      label: c.title ?? 'Beszélgetés',
    })),
    ...tickets
      .filter((t) => t.agentId === agentId || t.assigneeId === agentId)
      .slice(0, 25)
      .map((t) => ({ kind: 'ticket' as const, id: t.id, label: t.title })),
  ]
}

/** A domain-hibakódokból hétköznapi magyar üzenet — a UI-nak nem kell kódot fordítania. */
function grantFailureMessage(reason: string): string {
  switch (reason) {
    case 'subject_not_in_tenant':
      return 'A kiválasztott munkatárs vagy agent nem ehhez a szervezethez tartozik.'
    case 'target_not_in_tenant':
    case 'agent_not_in_tenant':
      return 'A kiválasztott agent nem ehhez a szervezethez tartozik.'
    case 'self_edge':
      return 'Egy agent önmagát mindig eléri — ehhez nem kell kapcsolatot felvenni.'
    case 'no_verb':
      return 'Legalább az egyik jogot be kell kapcsolni, különben a kapcsolatot törölni kell.'
    case 'panel_wizard_not_graph_node':
      return 'Ez a segéd csak a saját admin paneljéről indítható, kapcsolat nem vehető fel hozzá.'
    case 'web_egress_is_one_way':
      return 'A webes kutató egyirányú szolgáltató: hozzá lehet kapcsolódni, de ő nem kezdeményez.'
    case 'web_egress_requires_agent_subject':
      return 'A webes kutatót agent kéri fel, nem közvetlenül ember — válassz agentet alanynak.'
    case 'not_found':
      return 'Ez a kapcsolat már nem létezik.'
    default:
      return 'A kapcsolat mentése nem sikerült.'
  }
}
