/**
 * Agent-hozzáférési gráf — TISZTA policy-mag (Access-Policy §agent-scope, issue #142).
 *
 * Ez a modul DB-mentes és adapterfüggetlen: kizárólag már feloldott csomópontokból és
 * élekből dönt, ezért unit-tesztelhető és determinisztikus. A DB-t érintő feloldás a
 * `src/domain/agent-access/agent-access-service.ts`-ben van, de a DÖNTÉST mindig ez a
 * fájl hozza — a lista-szűrés és az explicit kapu ugyanezt a predicate-et hívja.
 *
 * ÜZLETI JELENTÉS: a felhasználó felé ez a „ki kivel beszélhet" szabály. Két külön
 * jogot ad:
 *  - `view`   — a subject megtudhatja, hogy a célagent létezik (böngésző/katalógus);
 *  - `address`— a subject chatet indíthat, ticketet címezhet, delegációt kezdeményezhet.
 * A kettő FÜGGETLEN: egy agent lehet nem listázható, de explicit módon megszólítható,
 * és fordítva. Ha ezt összemossuk, vagy „rejtett, tehát biztonságos"-ként kezelünk egy
 * agentet, azzal valós adatszivárgást engedünk — az ID ismerete sosem jogosultság.
 *
 * NORMATÍV INVARIÁNSOK (a spec 1–8 pontja):
 *  1. Az agent önálló principal: A→B hívásnál A a SAJÁT jogán jár el; a kezdeményező
 *     user joga nem metsződik és nem öröklődik. Ezért egy user→A grant A teljes
 *     elérhetőségi kúpjára ad hozzáférést (lásd `reachableAgentIds`).
 *  2. A láthatóság és a megszólíthatóság külön jog.
 *  3. A policy explicit, IRÁNYÍTOTT allow-élekből áll: nincs deny-szabály, A→B és B→A
 *     két külön él.
 *  4. Korlátozás nélkül a tenanton belüli kapcsolat grant nélkül engedett (C4).
 *  7. A tenant-határ ABSZOLÚT: grant nem tehet elérhetővé más tenant agentjét.
 *  8. Az él csak ELÉRÉST ad: nem ad tool capabilityt, nem kölcsönöz skillt.
 */

import { isWebEgressAgent } from '@/lib/platform-agent-registry'

/** Az elérési igék. Két független boolean, nem skála. */
export type AgentAccessVerb = 'view' | 'address'

/** A gráf alanya. Group/Team/OrgUnit szándékosan nincs (külön entitást igényelne). */
export type AgentAccessSubject =
  | { kind: 'user'; userId: string; tenantId: string }
  | { kind: 'agent'; agentId: string; tenantId: string }

/**
 * A döntéshez szükséges MINIMÁLIS célagent-adat. Szándékosan nem a teljes `Agent` —
 * így a mag nem függ a Prisma-modelltől, és a teszt tud „papír-agentet" adni.
 */
export type AgentAccessTargetNode = {
  id: string
  tenantId: string | null
  inboundRestricted: boolean
  outboundRestricted: boolean
  /** Katalógus-alkalmassági szabály; NEM a gráf része (lásd `target_hidden`). */
  hiddenFromOperators: boolean
  /** Perzisztált rendszer-szerep; csak a Web-Egress kezelt biztonsági principal. */
  systemRole?: string | null
  status: string
}

/** A forrás-agent (agent→agent útnál) döntéshez szükséges adatai. */
export type AgentAccessSourceNode = {
  id: string
  tenantId: string | null
  outboundRestricted: boolean
}

/** Egy feloldott él. `null`, ha a subject→target párra nincs sor. */
export type AgentAccessGrantEdge = {
  id: string
  canView: boolean
  canAddress: boolean
}

export type AgentAccessDenyReason =
  | 'tenant_boundary'
  | 'target_hidden'
  | 'missing_grant'
  | 'platform_agent_unreachable'

export type AgentAccessBasis =
  | { kind: 'grant'; grantId: string }
  | { kind: 'default-open' }

export type AgentAccessDecision =
  | { allowed: true; basis: AgentAccessBasis }
  | { allowed: false; reason: AgentAccessDenyReason }

/**
 * A `view` lista-szűrés extra bemenete: a `hiddenFromOperators` csak NON-ADMIN user
 * `view` döntését érinti, és grant NEM írja felül. Az admin org-ábra management
 * felületként minden tenant-gráfcsomópontot megkap (`includeAdminOnly`).
 */
export type AgentAccessEvaluationOptions = {
  /** True, ha a subject-user admin (vagy assume-tenant superadmin). */
  subjectIsTenantAdmin?: boolean
}

/**
 * Az `agent.access.*` audit `channel` mezője. A csatorna ADAT, nem külön eseménynév —
 * így egy lekérdezés minden úton látja a döntéseket.
 */
export type AgentAccessChannel = 'chat' | 'agent_ask' | 'ticket' | 'web_research'

/** Az explicit deny felfedési szintje (mennyit fedhetünk fel a cél létezéséről). */
export type AgentAccessDisclosure = 'forbidden' | 'not_found'

/**
 * A deny felfedési szintje: csak annyit fedünk fel, amennyit a subject `view` joga
 * már enged. Ha `view` engedett → 403 („van ilyen agent, de nem szólíthatod meg"),
 * ha `view` sem engedett → 404-jellegű („nem található"), hogy a cél LÉTEZÉSE ne
 * szivárogjon ki.
 */
export function disclosureForDeny(viewAllowed: boolean): AgentAccessDisclosure {
  return viewAllowed ? 'forbidden' : 'not_found'
}

/**
 * A dedikált-panel varázslók (Playbook Author, Provisioning Assistant, Skill
 * Distiller/Review) egyetlen `tenantId = null` példányként élnek, és NEM
 * gráfcsomópontok: chatből, ticketből, katalógusból és `agent_ask`-ból elérhetetlenek.
 * Csak a saját, jogosultsággal védett server actionjük indíthatja őket.
 *
 * Ez váltja fel a korábbi „`tenantId = null` minden tenantból elérhető" tool-kivételt:
 * az a kivétel egy tenant agentjének adott jogot arra, hogy platform-szintű,
 * privilegizált varázslót szólítson meg.
 */
export function isGraphNodeAgent(target: { tenantId: string | null }): boolean {
  return target.tenantId !== null
}

/**
 * A gráf-döntés MAGJA. A `canAccessAgent` és a `listAccessibleAgents` is ezt hívja —
 * a route-okban tilos a C4 defaultot, a platform-agent kivételt vagy a grant-feloldást
 * külön újraimplementálni.
 *
 * Sorrend számít: a tenant-határ és a platform-agent szabály MINDEN grant-adat előtt
 * dönt, hogy hibás vagy manipulált grant-sor se tudjon átvinni a tenant-határon.
 */
export function evaluateAgentAccess(params: {
  subject: AgentAccessSubject
  target: AgentAccessTargetNode
  /** Agent subjectnél kötelező: a forrás-agent csomópont. */
  source?: AgentAccessSourceNode | null
  /** A subject→target párra feloldott él (ha van). */
  grant?: AgentAccessGrantEdge | null
  verb: AgentAccessVerb
  options?: AgentAccessEvaluationOptions
}): AgentAccessDecision {
  const { subject, target, source, grant, verb, options } = params

  // 1. Panel-varázsló / platform-agent: nem gráfcsomópont, tool- és chat-úton
  //    elérhetetlen — függetlenül minden grant-adattól.
  if (!isGraphNodeAgent(target)) {
    return { allowed: false, reason: 'platform_agent_unreachable' }
  }

  // 2. Tenant-határ (I7, abszolút). Fail-closed: hibás grant-adat sem visz át.
  if (target.tenantId !== subject.tenantId) {
    return { allowed: false, reason: 'tenant_boundary' }
  }

  if (subject.kind === 'agent') {
    // A forrás-agentnek is a subject tenantjában kell lennie; platform-szintű
    // (tenantId=null) forrás nem gráf-alany.
    if (!source || source.id !== subject.agentId || source.tenantId !== subject.tenantId) {
      return { allowed: false, reason: 'tenant_boundary' }
    }
    // Self-edge nincs: egy agent önmagát mindig eléri, de a gráf ezt nem modellezi.
    if (source.id === target.id) {
      return { allowed: true, basis: { kind: 'default-open' } }
    }
  }

  // 3. `hiddenFromOperators`: katalógus-alkalmassági szabály, ami a GRÁF ELŐTT szűr a
  //    non-admin user `view` listáján, és amit grant NEM ír felül. Az `address`
  //    döntést nem befolyásolja — egy agent lehet nem listázható, de megszólítható.
  if (
    verb === 'view' &&
    subject.kind === 'user' &&
    target.hiddenFromOperators &&
    options?.subjectIsTenantAdmin !== true
  ) {
    return { allowed: false, reason: 'target_hidden' }
  }

  // 4. Explicit él szükségessége.
  // - user→agent: a cél `inboundRestricted` (üzleti alap: true → grant-mátrix)
  // - agent→agent: a forrás `outboundRestricted`, PLUSZ a Web-Egress cél inboundja
  //   (az marad grant-kötött). Normál tenant-agent inboundja CSAK az ember→agent
  //   pipákat zárja — különben a tömeges inbound=true minden agent_ask / roster /
  //   playbook-átadást missing_grant-re vinne.
  const needsGrant =
    subject.kind === 'user'
      ? target.inboundRestricted
      : (source?.outboundRestricted ?? true) || isWebEgressAgent(target)

  if (!needsGrant) {
    return { allowed: true, basis: { kind: 'default-open' } }
  }

  const verbAllowed = grant ? (verb === 'view' ? grant.canView : grant.canAddress) : false
  if (grant && verbAllowed) {
    return { allowed: true, basis: { kind: 'grant', grantId: grant.id } }
  }

  return { allowed: false, reason: 'missing_grant' }
}

/**
 * A tranzitív elérhetőségi kúp: MELY agenteket érheti el a subject közvetve, az
 * agentek saját `address` jogain keresztül (I1 — az agent önálló principal).
 *
 * Ez NEM külön authorization szabály, hanem a C1 (confused deputy) biztonsági hatás
 * MEGJELENÍTÉSE: egy user→A grant valójában A teljes kúpjára ad hozzáférést. Ezért
 * mutatja az admin UI a kúpot a grant/restriction szerkesztése mellett.
 *
 * - Ciklus engedett: a bejárás minden agentet EGYSZER vesz fel, így determinisztikusan
 *   terminál. A `hasCycle` VALÓDI irányított kört jelent (egy agent önmagát közvetve
 *   újra eléri), nem pusztán azt, hogy egy csomópont több úton is elérhető.
 * - Nincs policy-szintű mélységplafon (a futó delegáció mélysége külön runtime-védelem).
 * - Nincs cache-tábla: a szerver és a kliens UGYANEZT a tiszta algoritmust futtatja.
 */
export function reachableAgentIds(params: {
  /** A kúp gyökere: a közvetlenül `address`-elhető agentek. */
  seedAgentIds: string[]
  /** A tenant gráfcsomópontjai id → node. */
  nodes: Map<string, AgentAccessTargetNode>
  /** `subjectAgentId` → (targetAgentId → él) az `agent` alanyú élekre. */
  agentGrants: Map<string, Map<string, AgentAccessGrantEdge>>
  tenantId: string
}): { agentIds: string[]; maxDepth: number; hasCycle: boolean } {
  const { seedAgentIds, nodes, agentGrants, tenantId } = params

  /**
   * Egy forrás-agentből `address`-szel elérhető tenant-agentek. Csomópontonként
   * egyszer számoljuk ki és cache-eljük, mert a BFS és a ciklus-detektáló DFS is kéri.
   */
  const adjacencyCache = new Map<string, string[]>()
  const addressableFrom = (sourceId: string): string[] => {
    const cached = adjacencyCache.get(sourceId)
    if (cached) return cached
    const source = nodes.get(sourceId)
    const out: string[] = []
    if (source) {
      for (const [targetId, target] of nodes) {
        if (targetId === sourceId) continue
        const decision = evaluateAgentAccess({
          subject: { kind: 'agent', agentId: source.id, tenantId },
          target,
          source: {
            id: source.id,
            tenantId: source.tenantId,
            outboundRestricted: source.outboundRestricted,
          },
          grant: agentGrants.get(source.id)?.get(targetId) ?? null,
          verb: 'address',
        })
        if (decision.allowed) out.push(targetId)
      }
    }
    adjacencyCache.set(sourceId, out)
    return out
  }

  // 1. Elérhető halmaz + legrövidebb-út mélység: BFS, minden csomópontot EGYSZER
  //    veszünk sorba. Egy csomópont többszöri FELFEDEZÉSE (pl. gyémánt/DAG-minta:
  //    két külön kollégán át is elérhető ugyanaz az agent) NEM ciklus — ezt a
  //    korábbi „már láttam, tehát ciklus" jelzés hamisan körnek minősítette.
  const reached = new Set<string>()
  let maxDepth = 0
  type QueueItem = { agentId: string; depth: number }
  const queue: QueueItem[] = []

  for (const seed of seedAgentIds) {
    if (!nodes.has(seed) || reached.has(seed)) continue
    reached.add(seed)
    queue.push({ agentId: seed, depth: 1 })
  }

  while (queue.length > 0) {
    const item = queue.shift()!
    maxDepth = Math.max(maxDepth, item.depth)
    for (const targetId of addressableFrom(item.agentId)) {
      if (reached.has(targetId)) continue
      reached.add(targetId)
      queue.push({ agentId: targetId, depth: item.depth + 1 })
    }
  }

  // 2. Ciklus-detektálás az ELÉRHETŐ részgráfon: iteratív, három-színes (fehér/szürke/
  //    fekete) DFS. Egy MÉG NYITOTT (szürke, azaz az aktuális bejárási úton lévő)
  //    csomópontra visszamutató él = visszaél = valódi irányított kör. A gyémánt/DAG
  //    minta (közös leszármazott két úton) itt már feketévé zárult csomópontra mutat,
  //    ezért helyesen NEM számít ciklusnak.
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  let hasCycle = false

  for (const start of reached) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue
    const stack: Array<{ id: string; iter: Iterator<string> }> = []
    color.set(start, GRAY)
    stack.push({ id: start, iter: addressableFrom(start)[Symbol.iterator]() })
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const next = top.iter.next()
      if (next.done) {
        color.set(top.id, BLACK)
        stack.pop()
        continue
      }
      const child = next.value
      const childColor = color.get(child) ?? WHITE
      if (childColor === GRAY) {
        hasCycle = true
        continue
      }
      if (childColor === BLACK) continue
      color.set(child, GRAY)
      stack.push({ id: child, iter: addressableFrom(child)[Symbol.iterator]() })
    }
  }

  return { agentIds: [...reached], maxDepth, hasCycle }
}

/**
 * A kúp „soft figyelmeztetés" küszöbe (5 hop). Nem policy-plafon: a mély utat a
 * rendszer NEM vágja el, csak jelzi az adminnak, hogy egy grant meddig ér el.
 */
export const REACHABILITY_DEPTH_WARNING_THRESHOLD = 5

/**
 * Grant-alanyként / org-ábra munkatárs-sávjában elfogadott tagság-státuszok.
 *
 * Az `active` mellett a `pending` is kell: az admin előkészített, első belépésre
 * váró kollégáknak (user.status = pending + membership.status = pending) már az
 * első login ELŐTT be kell tudnia állítani, mely agenteket láthatják /
 * szólíthatják meg. A `suspended` szándékosan kimarad.
 */
export const AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES = ['active', 'pending'] as const

export type AgentAccessSubjectMembershipStatus =
  (typeof AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES)[number]

/** True, ha a tagság grant-alany / org-ábra szerkeszthető munkatárs lehet. */
export function isEligibleAgentAccessSubjectMembership(status: string): boolean {
  return (AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES as readonly string[]).includes(status)
}

/**
 * Org-ábra user-sáv: aktív és első belépésre váró (pending) userek.
 * Felfüggesztett userek kimaradnak.
 */
export function isEligibleAgentAccessGraphUserStatus(status: string): boolean {
  return status === 'active' || status === 'pending'
}

/**
 * True, ha a tenant gráfja TELJESEN korlátozás nélküli. Ilyenkor az implicit élek
 * száma N², amit értelmetlen kirajzolni — a UI helyette egy őszinte bannert mutat:
 * „Nincs korlátozás; ez a jog az egész tenant agenthálózatára kiterjed."
 */
export function isFullyDefaultOpen(nodes: Iterable<AgentAccessTargetNode>): boolean {
  for (const node of nodes) {
    if (node.inboundRestricted || node.outboundRestricted) return false
  }
  return true
}
