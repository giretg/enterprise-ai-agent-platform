/**
 * Agent-hozzáférési gráf — DOMAIN SERVICE (Access-Policy §agent-scope, issue #142).
 *
 * Ez az EGYETLEN hely, ahol a gráf-döntés feloldódik: minden chokepoint (prompt-roster,
 * katalógus, `agent_ask`, ticket-címzés, chat-indítás, felelős-választó, „suitable"
 * ajánló, web-research) ezt hívja. A route-okban TILOS a C4 defaultot, a platform-agent
 * kivételeket vagy a grant-feloldást külön-külön újraimplementálni — a lista-szűrés és
 * az explicit kapu ugyanabból a predicate-ből (`evaluateAgentAccess`) dolgozik, így nem
 * tudnak elcsúszni egymástól.
 *
 * ÜZLETI JELENTÉS: ha a lista és a kapu elcsúszik, a felhasználó olyan agentet választ
 * ki a felületen, amit a rendszer utána elutasít — ez a „miért nem működik?" hibaosztály.
 * Ezért az elfogadási feltétel is az, hogy a szűrt lista eredménye MEGEGYEZIK az
 * elemenkénti `canAccessAgent` döntések halmazával.
 */
import type { Prisma } from '@prisma/client'
import type { AuditRepository, AgentAccessGrantRepository } from '@/repositories/interfaces'
import {
  evaluateAgentAccess,
  isFullyDefaultOpen,
  reachableAgentIds,
  REACHABILITY_DEPTH_WARNING_THRESHOLD,
  type AgentAccessChannel,
  type AgentAccessDecision,
  type AgentAccessDisclosure,
  type AgentAccessGrantEdge,
  type AgentAccessSubject,
  type AgentAccessTargetNode,
  type AgentAccessVerb,
  disclosureForDeny,
} from '@/lib/agent-access-graph'
import { isAdminOnlyGraphNode, isPanelWizardAgent, isWebEgressAgent } from '@/lib/platform-agent-registry'
import { AgentAccessError } from './agent-access-errors'

/** A gráf-döntéshez és a UI-hoz szükséges agent-adatok (nem a teljes `Agent`). */
export type AgentGraphNode = AgentAccessTargetNode & {
  name: string
  avatarUrl?: string | null
  personaNickname: string | null
  personaTrait: string | null
  role: string
}

/**
 * A gráf agent-oldali olvasója. Szándékosan szűk: a service így DB nélkül is
 * tesztelhető, és nem függ az `AgentRepository` teljes felületétől.
 */
export interface AgentAccessAgentReader {
  findById(agentId: string): Promise<AgentGraphNode | null>
  /** A tenant MINDEN agentje (gráfcsomópont-jelöltek), szűrés nélkül. */
  listForTenant(tenantId: string): Promise<AgentGraphNode[]>
  /** Az inbound/outbound kapcsolók írása + az előző érték visszaadása (audithoz). */
  setRestrictions(input: {
    agentId: string
    inboundRestricted?: boolean
    outboundRestricted?: boolean
  }): Promise<{ previous: { inboundRestricted: boolean; outboundRestricted: boolean }; next: { inboundRestricted: boolean; outboundRestricted: boolean } }>
}

export type AgentAccessServiceDeps = {
  agents: AgentAccessAgentReader
  grants: AgentAccessGrantRepository
  audit: Pick<AuditRepository, 'append'>
}

/** A lista-szűrés opciói. */
export type ListAccessibleOptions = {
  /**
   * Admin/kormányzási felület: minden tenant-gráfcsomópont bekerül, beleértve a
   * `hiddenFromOperators` és a csak-admin Web-Egress csomópontokat is. A napi
   * operátori felületek EZT NEM adják meg.
   */
  includeAdminOnly?: boolean
  /** True, ha a subject-user tenant admin (a `hiddenFromOperators` szűrés miatt). */
  subjectIsTenantAdmin?: boolean
  /** Ha true, csak `active` státuszú agentek (csatorna-alkalmasság). */
  activeOnly?: boolean
}

/** Az explicit hozzáférési döntés audit-kontextusa. */
export type AccessAuditContext = {
  channel: AgentAccessChannel
  correlationId?: string | null
  ticketId?: string | null
  conversationId?: string | null
  /**
   * A kezdeményező ember, ha feloldható — AUDIT-KORRELÁCIÓKÉNT megőrizzük, de NEM
   * authorization subjectként: az agent a saját jogán jár el (I1), a user joga nem
   * öröklődik tovább a delegációs láncon.
   */
  initiatingUserId?: string | null
  agentVersion?: number | null
}

function subjectAuditFields(subject: AgentAccessSubject): Record<string, unknown> {
  return subject.kind === 'user'
    ? { subjectType: 'user', subjectId: subject.userId }
    : { subjectType: 'agent', subjectId: subject.agentId }
}

function toGrantEdge(row: {
  id: string
  canView: boolean
  canAddress: boolean
}): AgentAccessGrantEdge {
  return { id: row.id, canView: row.canView, canAddress: row.canAddress }
}

export type RestrictionDryRun = {
  agentId: string
  agentName: string
  current: { inboundRestricted: boolean; outboundRestricted: boolean }
  next: { inboundRestricted: boolean; outboundRestricted: boolean }
  /** Mely ma IMPLICIT (grant nélküli) kapcsolatok szűnnek meg. */
  losingConnections: Array<{
    direction: 'inbound' | 'outbound'
    subjectKind: 'user' | 'agent'
    subjectId: string
    subjectLabel: string
    targetAgentId: string
    targetLabel: string
    verb: AgentAccessVerb
  }>
  /** Mely explicit éleket kellene megtartani (már most is granttel fedettek). */
  keepExplicitGrantIds: string[]
  /** A változás UTÁNI elérhetőségi kúp mérete az érintett agentből. */
  coneAfter: { agentIds: string[]; maxDepth: number; hasCycle: boolean }
  /** Aktív chat/ticket/delegációs utak, amelyeket a szűkítés érint. */
  affectedActivePaths: Array<{ kind: 'conversation' | 'ticket'; id: string; label: string }>
}

export class AgentAccessService {
  constructor(private readonly deps: AgentAccessServiceDeps) {}

  // ── Döntés ────────────────────────────────────────────────────────────────

  /**
   * Egyetlen explicit hozzáférési döntés. NEM ír auditot: a hívó chokepoint tudja, mi
   * a csatorna és a korreláció, ezért az auditálás külön, nevesített lépés
   * (`recordAccessDecision`). Így a lista-szűrés (ami nem ír deny-eseményt) és az
   * explicit próba (ami ír) ugyanezt a döntést használhatja.
   */
  async canAccessAgent(
    subject: AgentAccessSubject,
    targetAgentId: string,
    verb: AgentAccessVerb,
    options?: { subjectIsTenantAdmin?: boolean; includeAdminOnly?: boolean },
  ): Promise<AgentAccessDecision> {
    const target = await this.deps.agents.findById(targetAgentId)
    if (!target) return { allowed: false, reason: 'platform_agent_unreachable' }

    // Panel-varázsló: nem gráfcsomópont, tool-/chat-úton elérhetetlen.
    if (isPanelWizardAgent({ name: target.name, tenantId: target.tenantId })) {
      return { allowed: false, reason: 'platform_agent_unreachable' }
    }

    // Web-Egress: user SOHA nem címezheti közvetlenül a napi felületeken. Az admin
    // kormányzási felület (`includeAdminOnly`) látja a csomópontot, de a chat/ticket
    // úton user→Web-Egress nem nyílik meg.
    if (
      subject.kind === 'user' &&
      isWebEgressAgent(target) &&
      options?.includeAdminOnly !== true
    ) {
      return { allowed: false, reason: 'missing_grant' }
    }

    const source =
      subject.kind === 'agent' ? await this.deps.agents.findById(subject.agentId) : null

    // Web-Egress egyirányú szolgáltató: kimenő él nem hozható létre és nem is dönthet
    // engedésről — a Web-Egress agent nem szólíthat meg más tenant-agentet a gráfon.
    if (source && isWebEgressAgent(source)) {
      return { allowed: false, reason: 'missing_grant' }
    }

    const grant = await this.deps.grants.findEdge({
      tenantId: subject.tenantId,
      subjectType: subject.kind,
      subjectUserId: subject.kind === 'user' ? subject.userId : null,
      subjectAgentId: subject.kind === 'agent' ? subject.agentId : null,
      targetAgentId,
    })

    return evaluateAgentAccess({
      subject,
      target,
      source: source
        ? {
            id: source.id,
            tenantId: source.tenantId,
            outboundRestricted: source.outboundRestricted,
          }
        : null,
      grant: grant ? toGrantEdge(grant) : null,
      verb,
      options: { subjectIsTenantAdmin: options?.subjectIsTenantAdmin },
    })
  }

  /**
   * A szűrt lista. UGYANAZT a predicate-et futtatja minden jelöltre, egyetlen
   * agent-lekérdezéssel és egyetlen grant-lekérdezéssel (nincs N+1).
   */
  async listAccessibleAgents(
    subject: AgentAccessSubject,
    verb: AgentAccessVerb,
    options?: ListAccessibleOptions,
  ): Promise<AgentGraphNode[]> {
    const [all, edges] = await Promise.all([
      this.deps.agents.listForTenant(subject.tenantId),
      this.deps.grants.listBySubject({
        tenantId: subject.tenantId,
        subjectType: subject.kind,
        subjectUserId: subject.kind === 'user' ? subject.userId : null,
        subjectAgentId: subject.kind === 'agent' ? subject.agentId : null,
      }),
    ])

    const grantByTarget = new Map<string, AgentAccessGrantEdge>()
    for (const edge of edges) grantByTarget.set(edge.targetAgentId, toGrantEdge(edge))

    const source =
      subject.kind === 'agent' ? all.find((a) => a.id === subject.agentId) ?? null : null
    // Web-Egress egyirányú szolgáltató: nincs kimenő éle, ezért üres listát ad.
    if (source && isWebEgressAgent(source)) return []

    const result: AgentGraphNode[] = []
    for (const candidate of all) {
      if (subject.kind === 'agent' && candidate.id === subject.agentId) continue
      if (isPanelWizardAgent({ name: candidate.name, tenantId: candidate.tenantId })) continue
      if (options?.activeOnly && candidate.status !== 'active') continue
      // A csak-admin csomópont (Web-Egress) nem kerül a napi operátori felületekre.
      // Agent subject viszont a saját `address` grantján keresztül elérheti — a
      // webes kutatást agent kéri agenttől, ezért ott nem szűrünk.
      if (
        subject.kind === 'user' &&
        !options?.includeAdminOnly &&
        isAdminOnlyGraphNode(candidate)
      ) {
        continue
      }

      const decision = evaluateAgentAccess({
        subject,
        target: candidate,
        source: source
          ? { id: source.id, tenantId: source.tenantId, outboundRestricted: source.outboundRestricted }
          : null,
        grant: grantByTarget.get(candidate.id) ?? null,
        verb,
        options: { subjectIsTenantAdmin: options?.subjectIsTenantAdmin },
      })
      if (decision.allowed) result.push(candidate)
    }
    return result
  }

  /**
   * Az explicit kapu a chokepointokhoz: engedésnél `agent.access.granted`, elutasításnál
   * `agent.access.denied` auditot ír, és tipizált hibát dob. A felfedési szintet a
   * subject `view` joga dönti el — 403 vagy 404-jellegű válasz.
   *
   * FONTOS: a lista-szűrésből kimaradó agentre NEM keletkezik deny-esemény; ez a
   * metódus kizárólag EXPLICIT célpróbán fut.
   */
  async assertCanAccessAgent(params: {
    subject: AgentAccessSubject
    targetAgentId: string
    verb: AgentAccessVerb
    audit: AccessAuditContext
    subjectIsTenantAdmin?: boolean
  }): Promise<AgentAccessDecision & { allowed: true }> {
    const decision = await this.canAccessAgent(
      params.subject,
      params.targetAgentId,
      params.verb,
      { subjectIsTenantAdmin: params.subjectIsTenantAdmin },
    )

    if (decision.allowed) {
      await this.recordAccessDecision({
        subject: params.subject,
        targetAgentId: params.targetAgentId,
        verb: params.verb,
        decision,
        audit: params.audit,
      })
      return decision
    }

    // A felfedés csak annyit engedhet, amennyit a `view` jog már ad. `address`
    // próbánál ezért külön megkérdezzük a `view` döntést.
    const viewAllowed =
      params.verb === 'view'
        ? false
        : (
            await this.canAccessAgent(params.subject, params.targetAgentId, 'view', {
              subjectIsTenantAdmin: params.subjectIsTenantAdmin,
            })
          ).allowed

    const disclosure = disclosureForDeny(viewAllowed)
    await this.recordAccessDecision({
      subject: params.subject,
      targetAgentId: params.targetAgentId,
      verb: params.verb,
      decision,
      audit: params.audit,
      disclosure,
    })

    throw disclosure === 'forbidden'
      ? AgentAccessError.forbidden(decision.reason)
      : AgentAccessError.notFound(decision.reason)
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  /**
   * Egy explicit hozzáférési döntés strukturált auditja. Az engedés alapja
   * (`grantId` vagy `default-open`) BENNE van, hogy a C1 szerinti confused-deputy
   * lánc utólag rekonstruálható legyen.
   */
  async recordAccessDecision(params: {
    subject: AgentAccessSubject
    targetAgentId: string
    verb: AgentAccessVerb
    decision: AgentAccessDecision
    audit: AccessAuditContext
    disclosure?: AgentAccessDisclosure
  }): Promise<void> {
    const { subject, decision, audit } = params
    const metadata: Record<string, unknown> = {
      ...subjectAuditFields(subject),
      targetAgentId: params.targetAgentId,
      verb: params.verb,
      channel: audit.channel,
      correlationId: audit.correlationId ?? null,
      initiatingUserId: audit.initiatingUserId ?? null,
    }
    if (decision.allowed) {
      metadata.decisionBasis =
        decision.basis.kind === 'grant' ? decision.basis.grantId : 'default-open'
    } else {
      metadata.reason = decision.reason
      metadata.disclosure = params.disclosure ?? disclosureForDeny(false)
    }

    await this.deps.audit.append({
      actorType: subject.kind === 'user' ? 'human' : 'agent',
      actorId: subject.kind === 'user' ? subject.userId : subject.agentId,
      agentVersion: audit.agentVersion ?? null,
      action: decision.allowed ? 'agent.access.granted' : 'agent.access.denied',
      targetType: 'agent',
      targetId: params.targetAgentId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: decision.allowed ? 'allowed' : 'denied',
      tenantId: subject.tenantId,
      ticketId: audit.ticketId ?? null,
      conversationId: audit.conversationId ?? null,
      metadata: metadata as Prisma.JsonValue,
    })
  }

  /**
   * Playbook/Process és Monitor-cron SHADOW check (a spec „Playbook- és Monitor-
   * megkerülő út" fejezete). A folyamat-definíció maga a runtime principal
   * jogosítványa, ezért a folyamat NEM áll meg az ad-hoc gráf deny döntésén — de
   * `agent.access.bypass` eseményt írunk, hogy a compliance-felelős lássa az utat.
   *
   * Ez auditál, nem blokkol. Ha később enforcementté válna, az külön policy-döntés.
   */
  async recordProcessBypass(params: {
    subject: AgentAccessSubject
    targetAgentId: string
    verb: AgentAccessVerb
    processInstanceId?: string | null
    processDefinitionId?: string | null
    playbookVersionId?: string | null
    monitorDefinitionId?: string | null
    ticketId?: string | null
  }): Promise<void> {
    const decision = await this.canAccessAgent(params.subject, params.targetAgentId, params.verb)
    if (decision.allowed) return

    await this.deps.audit.append({
      actorType: params.subject.kind === 'user' ? 'human' : 'agent',
      actorId: params.subject.kind === 'user' ? params.subject.userId : params.subject.agentId,
      agentVersion: null,
      action: 'agent.access.bypass',
      targetType: 'agent',
      targetId: params.targetAgentId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      // A folyamat FUT — a shadow döntés csak megfigyelés, ezért nem `denied`.
      policyDecision: 'shadow_denied',
      tenantId: params.subject.tenantId,
      ticketId: params.ticketId ?? null,
      metadata: {
        ...subjectAuditFields(params.subject),
        targetAgentId: params.targetAgentId,
        verb: params.verb,
        shadowDecision: 'denied',
        shadowReason: decision.reason,
        processInstanceId: params.processInstanceId ?? null,
        processDefinitionId: params.processDefinitionId ?? null,
        playbookVersionId: params.playbookVersionId ?? null,
        monitorDefinitionId: params.monitorDefinitionId ?? null,
      } as Prisma.JsonValue,
    })
  }

  // ── Policy-szerkesztés (csak tenant admin) ────────────────────────────────

  /**
   * Egy él létrehozása/bővítése/szűkítése. Mindkét ige levétele a SOR TÖRLÉSÉT jelenti
   * (`canView=false && canAddress=false`), nem egy „üres" grantot.
   *
   * A Web-Egress egyirányú szolgáltató: kimenő él (Web-Egress → bármi) nem hozható létre.
   * A panel-varázslók nem gráfcsomópontok, ezért sem alanyuk, sem céljuk nem lehet.
   */
  async setGrant(params: {
    tenantId: string
    subject: { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string }
    targetAgentId: string
    canView: boolean
    canAddress: boolean
    actorUserId: string
  }): Promise<
    | { ok: true; action: 'created' | 'updated' | 'deleted'; grantId: string | null }
    | { ok: false; reason: string }
  > {
    const target = await this.deps.agents.findById(params.targetAgentId)
    if (!target || target.tenantId !== params.tenantId) {
      return { ok: false, reason: 'target_not_in_tenant' }
    }
    if (isPanelWizardAgent({ name: target.name, tenantId: target.tenantId })) {
      return { ok: false, reason: 'panel_wizard_not_graph_node' }
    }

    if (params.subject.kind === 'agent') {
      const source = await this.deps.agents.findById(params.subject.agentId)
      if (!source || source.tenantId !== params.tenantId) {
        return { ok: false, reason: 'subject_not_in_tenant' }
      }
      if (isPanelWizardAgent({ name: source.name, tenantId: source.tenantId })) {
        return { ok: false, reason: 'panel_wizard_not_graph_node' }
      }
      if (isWebEgressAgent(source)) {
        return { ok: false, reason: 'web_egress_is_one_way' }
      }
    } else if (isWebEgressAgent(target)) {
      // user→Web-Egress nincs a napi felületeken: a webes kutatást agent kéri agenttől.
      return { ok: false, reason: 'web_egress_requires_agent_subject' }
    }

    const key = {
      tenantId: params.tenantId,
      subjectType: params.subject.kind,
      subjectUserId: params.subject.kind === 'user' ? params.subject.userId : null,
      subjectAgentId: params.subject.kind === 'agent' ? params.subject.agentId : null,
      targetAgentId: params.targetAgentId,
    } as const

    const auditBase = {
      actorType: 'human' as const,
      actorId: params.actorUserId,
      agentVersion: null,
      targetType: 'agent_access_grant',
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      tenantId: params.tenantId,
    }

    // Mindkét ige levétele = a sor törlése (a DB CHECK sem engedne false/false sort).
    if (!params.canView && !params.canAddress) {
      const deleted = await this.deps.grants.deleteEdge({
        ...key,
        buildAudit: (change) => ({
          ...auditBase,
          action: 'agent_access.grant.revoke',
          targetId: change.grantId,
          policyDecision: 'revoked',
          metadata: {
            ...subjectAuditFields(
              params.subject.kind === 'user'
                ? { kind: 'user', userId: params.subject.userId, tenantId: params.tenantId }
                : { kind: 'agent', agentId: params.subject.agentId, tenantId: params.tenantId },
            ),
            targetAgentId: params.targetAgentId,
            grantId: change.grantId,
            previous: change.previous,
            next: change.next,
          } as Prisma.JsonValue,
        }),
      })
      if (!deleted.ok) return { ok: false, reason: deleted.reason }
      return { ok: true, action: 'deleted', grantId: deleted.grantId }
    }

    const written = await this.deps.grants.upsertEdge({
      ...key,
      canView: params.canView,
      canAddress: params.canAddress,
      grantedById: params.actorUserId,
      buildAudit: (change) => ({
        ...auditBase,
        // Szűkítés is `revoke`: az esemény azt írja le, MERRE mozdult a policy.
        action: isNarrowing(change.previous, change.next)
          ? 'agent_access.grant.revoke'
          : 'agent_access.grant.create',
        targetId: change.grantId,
        policyDecision: isNarrowing(change.previous, change.next) ? 'revoked' : 'granted',
        metadata: {
          ...subjectAuditFields(
            params.subject.kind === 'user'
              ? { kind: 'user', userId: params.subject.userId, tenantId: params.tenantId }
              : { kind: 'agent', agentId: params.subject.agentId, tenantId: params.tenantId },
          ),
          targetAgentId: params.targetAgentId,
          grantId: change.grantId,
          previous: change.previous,
          next: change.next,
        } as Prisma.JsonValue,
      }),
    })

    if (!written.ok) return { ok: false, reason: written.reason }
    return {
      ok: true,
      action: written.previous ? 'updated' : 'created',
      grantId: written.grant.id,
    }
  }

  /** Az inbound/outbound kapcsoló váltása + `agent_access.restriction.update` audit. */
  async setRestrictions(params: {
    tenantId: string
    agentId: string
    inboundRestricted?: boolean
    outboundRestricted?: boolean
    actorUserId: string
  }): Promise<{ ok: true; inboundRestricted: boolean; outboundRestricted: boolean } | { ok: false; reason: string }> {
    const agent = await this.deps.agents.findById(params.agentId)
    if (!agent || agent.tenantId !== params.tenantId) {
      return { ok: false, reason: 'agent_not_in_tenant' }
    }
    if (isPanelWizardAgent({ name: agent.name, tenantId: agent.tenantId })) {
      return { ok: false, reason: 'panel_wizard_not_graph_node' }
    }

    const changed = await this.deps.agents.setRestrictions({
      agentId: params.agentId,
      inboundRestricted: params.inboundRestricted,
      outboundRestricted: params.outboundRestricted,
    })

    await this.deps.audit.append({
      actorType: 'human',
      actorId: params.actorUserId,
      agentVersion: null,
      action: 'agent_access.restriction.update',
      targetType: 'agent',
      targetId: params.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      tenantId: params.tenantId,
      metadata: {
        agentId: params.agentId,
        previous: changed.previous,
        next: changed.next,
      } as Prisma.JsonValue,
    })

    return { ok: true, ...changed.next }
  }

  // ── Org-ábra / kúp / dry-run ──────────────────────────────────────────────

  /**
   * Az admin org-ábra teljes gráfmásolata. A kliens UGYANEZT a tiszta reachability-
   * algoritmust futtatja rajta a kúp megjelenítéséhez — nincs cache-tábla, nincs két
   * külön implementáció.
   */
  async loadTenantGraph(tenantId: string): Promise<{
    nodes: AgentGraphNode[]
    grants: Array<{
      id: string
      subjectType: 'user' | 'agent'
      subjectUserId: string | null
      subjectAgentId: string | null
      targetAgentId: string
      canView: boolean
      canAddress: boolean
    }>
    fullyDefaultOpen: boolean
  }> {
    const [all, edges] = await Promise.all([
      this.deps.agents.listForTenant(tenantId),
      this.deps.grants.listForTenant(tenantId),
    ])
    // Az org-ábra MINDEN tenant-gráfcsomópontot mutat (rejtett + admin-only is), de a
    // panel-varázslók nem gráfcsomópontok, ezért ott sem jelennek meg.
    const nodes = all.filter((a) => !isPanelWizardAgent({ name: a.name, tenantId: a.tenantId }))
    return {
      nodes,
      grants: edges.map((e) => ({
        id: e.id,
        subjectType: e.subjectType,
        subjectUserId: e.subjectUserId,
        subjectAgentId: e.subjectAgentId,
        targetAgentId: e.targetAgentId,
        canView: e.canView,
        canAddress: e.canAddress,
      })),
      fullyDefaultOpen: isFullyDefaultOpen(nodes),
    }
  }

  /**
   * A subject tranzitív elérhetőségi kúpja. A közvetlenül `address`-elhető agentekből
   * indul, majd az AGENTEK SAJÁT `address` jogain megy tovább (I1) — ez mutatja meg,
   * hogy egy user→A grant valójában mekkora hálózatra ad hozzáférést.
   */
  async reachabilityCone(
    subject: AgentAccessSubject,
    options?: { includeAdminOnly?: boolean; subjectIsTenantAdmin?: boolean },
  ): Promise<{
    agentIds: string[]
    maxDepth: number
    hasCycle: boolean
    depthWarning: boolean
    fullyDefaultOpen: boolean
  }> {
    const [all, agentEdges, direct] = await Promise.all([
      this.deps.agents.listForTenant(subject.tenantId),
      this.deps.grants.listAgentEdgesForTenant(subject.tenantId),
      this.listAccessibleAgents(subject, 'address', {
        includeAdminOnly: options?.includeAdminOnly,
        subjectIsTenantAdmin: options?.subjectIsTenantAdmin,
      }),
    ])

    const nodes = new Map<string, AgentGraphNode>()
    for (const node of all) {
      if (isPanelWizardAgent({ name: node.name, tenantId: node.tenantId })) continue
      nodes.set(node.id, node)
    }

    const agentGrants = new Map<string, Map<string, AgentAccessGrantEdge>>()
    for (const edge of agentEdges) {
      if (!edge.subjectAgentId) continue
      const inner = agentGrants.get(edge.subjectAgentId) ?? new Map<string, AgentAccessGrantEdge>()
      inner.set(edge.targetAgentId, toGrantEdge(edge))
      agentGrants.set(edge.subjectAgentId, inner)
    }

    const cone = reachableAgentIds({
      seedAgentIds: direct.map((a) => a.id),
      nodes,
      agentGrants,
      tenantId: subject.tenantId,
    })

    return {
      ...cone,
      depthWarning: cone.maxDepth >= REACHABILITY_DEPTH_WARNING_THRESHOLD,
      fullyDefaultOpen: isFullyDefaultOpen(nodes.values()),
    }
  }

  /**
   * Restriction bekapcsolása ELŐTTI kötelező dry-run. Megmutatja, mely ma működő
   * (implicit) kapcsolatok szűnnek meg, mely explicit éleket kellene megtartani, és
   * mekkora lesz a kúp a változás után. NEM generál automatikusan éleket.
   *
   * ÜZLETI JELENTÉS: ez az a kapu, ami megakadályozza, hogy egy jószándékú szigorítás
   * észrevétlenül elvágjon élő chat- és ticket-utakat.
   */
  async previewRestrictionChange(params: {
    tenantId: string
    agentId: string
    inboundRestricted?: boolean
    outboundRestricted?: boolean
    /** Élő beszélgetés-/ticket-utak feloldója (opcionális, a UI figyelmeztetéshez). */
    activePathReader?: (agentId: string) => Promise<RestrictionDryRun['affectedActivePaths']>
  }): Promise<RestrictionDryRun | { ok: false; reason: string }> {
    const agent = await this.deps.agents.findById(params.agentId)
    if (!agent || agent.tenantId !== params.tenantId) {
      return { ok: false, reason: 'agent_not_in_tenant' }
    }

    const current = {
      inboundRestricted: agent.inboundRestricted,
      outboundRestricted: agent.outboundRestricted,
    }
    const next = {
      inboundRestricted: params.inboundRestricted ?? current.inboundRestricted,
      outboundRestricted: params.outboundRestricted ?? current.outboundRestricted,
    }

    const [all, allEdges, memberIds] = await Promise.all([
      this.deps.agents.listForTenant(params.tenantId),
      this.deps.grants.listForTenant(params.tenantId),
      this.listTenantMemberIdsForPreview(params.tenantId),
    ])

    const nodes = new Map<string, AgentGraphNode>()
    for (const node of all) {
      if (isPanelWizardAgent({ name: node.name, tenantId: node.tenantId })) continue
      nodes.set(node.id, node)
    }
    const nextNodes = new Map(nodes)
    nextNodes.set(params.agentId, { ...agent, ...next })

    const label = (id: string) => {
      const node = nodes.get(id)
      return node ? node.personaNickname ?? node.name : id
    }

    const edgeFor = (
      subjectType: 'user' | 'agent',
      subjectId: string,
      targetId: string,
    ): AgentAccessGrantEdge | null => {
      const row = allEdges.find(
        (e) =>
          e.targetAgentId === targetId &&
          (subjectType === 'user' ? e.subjectUserId === subjectId : e.subjectAgentId === subjectId),
      )
      return row ? toGrantEdge(row) : null
    }

    const losing: RestrictionDryRun['losingConnections'] = []
    const keep = new Set<string>()

    const verbs: AgentAccessVerb[] = ['view', 'address']

    /** Egy (subject, target) pár összevetése a mostani és a jövőbeli kapcsolókkal. */
    const compare = (
      subject: AgentAccessSubject,
      targetId: string,
      direction: 'inbound' | 'outbound',
      subjectLabel: string,
    ) => {
      const before = nodes.get(targetId)
      const after = nextNodes.get(targetId)
      if (!before || !after) return
      const sourceBefore = subject.kind === 'agent' ? nodes.get(subject.agentId) : null
      const sourceAfter = subject.kind === 'agent' ? nextNodes.get(subject.agentId) : null
      if (subject.kind === 'agent' && (!sourceBefore || !sourceAfter)) return

      const grant = edgeFor(
        subject.kind,
        subject.kind === 'user' ? subject.userId : subject.agentId,
        targetId,
      )

      for (const verb of verbs) {
        const wasAllowed = evaluateAgentAccess({
          subject,
          target: before,
          source: sourceBefore
            ? { id: sourceBefore.id, tenantId: sourceBefore.tenantId, outboundRestricted: sourceBefore.outboundRestricted }
            : null,
          grant,
          verb,
          options: { subjectIsTenantAdmin: true },
        })
        const willBeAllowed = evaluateAgentAccess({
          subject,
          target: after,
          source: sourceAfter
            ? { id: sourceAfter.id, tenantId: sourceAfter.tenantId, outboundRestricted: sourceAfter.outboundRestricted }
            : null,
          grant,
          verb,
          options: { subjectIsTenantAdmin: true },
        })

        if (wasAllowed.allowed && !willBeAllowed.allowed) {
          losing.push({
            direction,
            subjectKind: subject.kind,
            subjectId: subject.kind === 'user' ? subject.userId : subject.agentId,
            subjectLabel,
            targetAgentId: targetId,
            targetLabel: label(targetId),
            verb,
          })
        }
        if (willBeAllowed.allowed && willBeAllowed.basis.kind === 'grant') {
          keep.add(willBeAllowed.basis.grantId)
        }
      }
    }

    // Bejövő irány: user→agent és agent→agent a MOST szigorított agent felé.
    if (next.inboundRestricted !== current.inboundRestricted) {
      for (const userId of memberIds) {
        compare(
          { kind: 'user', userId, tenantId: params.tenantId },
          params.agentId,
          'inbound',
          userId,
        )
      }
      for (const source of nodes.values()) {
        if (source.id === params.agentId) continue
        compare(
          { kind: 'agent', agentId: source.id, tenantId: params.tenantId },
          params.agentId,
          'inbound',
          source.personaNickname ?? source.name,
        )
      }
    }

    // Kimenő irány: a szigorított agentből MINDEN másik tenant-agent felé.
    if (next.outboundRestricted !== current.outboundRestricted) {
      for (const target of nodes.values()) {
        if (target.id === params.agentId) continue
        compare(
          { kind: 'agent', agentId: params.agentId, tenantId: params.tenantId },
          target.id,
          'outbound',
          agent.personaNickname ?? agent.name,
        )
      }
    }

    // A változás UTÁNI kúp: a szigorított agentből induló elérhetőség.
    const agentGrants = new Map<string, Map<string, AgentAccessGrantEdge>>()
    for (const edge of allEdges) {
      if (!edge.subjectAgentId) continue
      const inner = agentGrants.get(edge.subjectAgentId) ?? new Map<string, AgentAccessGrantEdge>()
      inner.set(edge.targetAgentId, toGrantEdge(edge))
      agentGrants.set(edge.subjectAgentId, inner)
    }
    const seeds: string[] = []
    for (const target of nextNodes.values()) {
      if (target.id === params.agentId) continue
      const decision = evaluateAgentAccess({
        subject: { kind: 'agent', agentId: params.agentId, tenantId: params.tenantId },
        target,
        source: { id: params.agentId, tenantId: params.tenantId, outboundRestricted: next.outboundRestricted },
        grant: edgeFor('agent', params.agentId, target.id),
        verb: 'address',
      })
      if (decision.allowed) seeds.push(target.id)
    }
    const coneAfter = reachableAgentIds({
      seedAgentIds: seeds,
      nodes: nextNodes,
      agentGrants,
      tenantId: params.tenantId,
    })

    const affectedActivePaths = params.activePathReader
      ? await params.activePathReader(params.agentId)
      : []

    return {
      agentId: params.agentId,
      agentName: agent.personaNickname ?? agent.name,
      current,
      next,
      losingConnections: losing,
      keepExplicitGrantIds: [...keep],
      coneAfter,
      affectedActivePaths,
    }
  }

  /**
   * A dry-run user-oldali alanyai. Külön metódus, hogy a szolgáltatás DB-mentesen is
   * tesztelhető legyen (a `tenantMemberReader` opcionális dependency).
   */
  private async listTenantMemberIdsForPreview(tenantId: string): Promise<string[]> {
    if (!this.tenantMemberReader) return []
    return this.tenantMemberReader(tenantId)
  }

  /** Opcionális olvasó a dry-run user-alanyaihoz (a domain wiring állítja be). */
  tenantMemberReader: ((tenantId: string) => Promise<string[]>) | null = null
}

/** True, ha a változás SZŰKÍTÉS (bármelyik ige igazról hamisra ment). */
function isNarrowing(
  previous: { canView: boolean; canAddress: boolean } | null,
  next: { canView: boolean; canAddress: boolean },
): boolean {
  if (!previous) return false
  return (previous.canView && !next.canView) || (previous.canAddress && !next.canAddress)
}
