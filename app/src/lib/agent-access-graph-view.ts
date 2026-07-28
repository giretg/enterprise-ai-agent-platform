/**
 * Az org-ábra KLIENS-oldali gráfmodellje (Access-Policy §agent-scope, issue #142).
 *
 * A kliens UGYANAZT a tiszta reachability-algoritmust futtatja, mint a szerver
 * (`@/lib/agent-access-graph`) — nincs külön cache-tábla és nincs második
 * implementáció, ami elcsúszhatna a szerver döntésétől. Ez a modul csak a szerverről
 * érkező, sorosított gráfot fordítja a mag által várt alakra.
 */
import {
  evaluateAgentAccess,
  reachableAgentIds,
  type AgentAccessGrantEdge,
  type AgentAccessTargetNode,
  type AgentAccessVerb,
} from '@/lib/agent-access-graph'

export type GraphAgentView = {
  id: string
  name: string
  nickname: string
  role: string
  status: string
  hiddenFromOperators: boolean
  inboundRestricted: boolean
  outboundRestricted: boolean
  /** Csak admin/kormányzási felületen látszó csomópont (ma: a webes kutató). */
  adminOnly: boolean
}

export type GraphUserView = {
  id: string
  name: string
  email: string
  role: string
}

export type GraphGrantView = {
  id: string
  subjectType: 'user' | 'agent'
  subjectUserId: string | null
  subjectAgentId: string | null
  targetAgentId: string
  canView: boolean
  canAddress: boolean
}

export type GraphSubject =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string }

function toTargetNode(agent: GraphAgentView, tenantId: string): AgentAccessTargetNode {
  return {
    id: agent.id,
    tenantId,
    inboundRestricted: agent.inboundRestricted,
    outboundRestricted: agent.outboundRestricted,
    hiddenFromOperators: agent.hiddenFromOperators,
    status: agent.status,
  }
}

function findGrant(
  grants: GraphGrantView[],
  subject: GraphSubject,
  targetAgentId: string,
): AgentAccessGrantEdge | null {
  const row = grants.find(
    (g) =>
      g.targetAgentId === targetAgentId &&
      (subject.kind === 'user' ? g.subjectUserId === subject.id : g.subjectAgentId === subject.id),
  )
  return row ? { id: row.id, canView: row.canView, canAddress: row.canAddress } : null
}

/**
 * Egy alany→cél kapcsolat MAI állapota a UI-nak: engedett-e, és ha igen, EXPLICIT
 * élen vagy korlátozás hiányában (implicit).
 *
 * Ez a különbségtétel az, amitől a szerkesztő őszinte: az implicit kapcsolat nem
 * „beállított jog", hanem a korlátozás HIÁNYA — ha az admin bekapcsol egy korlátozást,
 * pontosan ezek szűnnek meg csendben.
 */
export function connectionState(params: {
  tenantId: string
  agents: GraphAgentView[]
  grants: GraphGrantView[]
  subject: GraphSubject
  targetAgentId: string
  verb: AgentAccessVerb
  subjectIsTenantAdmin?: boolean
}): { allowed: boolean; basis: 'grant' | 'implicit' | null } {
  const target = params.agents.find((a) => a.id === params.targetAgentId)
  if (!target) return { allowed: false, basis: null }
  const source =
    params.subject.kind === 'agent'
      ? params.agents.find((a) => a.id === params.subject.id) ?? null
      : null

  const decision = evaluateAgentAccess({
    subject:
      params.subject.kind === 'user'
        ? { kind: 'user', userId: params.subject.id, tenantId: params.tenantId }
        : { kind: 'agent', agentId: params.subject.id, tenantId: params.tenantId },
    target: toTargetNode(target, params.tenantId),
    source: source
      ? { id: source.id, tenantId: params.tenantId, outboundRestricted: source.outboundRestricted }
      : null,
    grant: findGrant(params.grants, params.subject, params.targetAgentId),
    verb: params.verb,
    options: { subjectIsTenantAdmin: params.subjectIsTenantAdmin },
  })

  if (!decision.allowed) return { allowed: false, basis: null }
  return { allowed: true, basis: decision.basis.kind === 'grant' ? 'grant' : 'implicit' }
}

/**
 * Az alany tranzitív elérhetőségi köre a betöltött gráfmásolaton. Ugyanaz az
 * algoritmus, mint a szerveren — a kliens csak megjelenít, nem dönt újra.
 */
export function reachabilityConeFor(params: {
  tenantId: string
  agents: GraphAgentView[]
  grants: GraphGrantView[]
  subject: GraphSubject
  subjectIsTenantAdmin?: boolean
}): { agentIds: string[]; maxDepth: number; hasCycle: boolean } {
  const nodes = new Map<string, AgentAccessTargetNode>()
  for (const agent of params.agents) nodes.set(agent.id, toTargetNode(agent, params.tenantId))

  const agentGrants = new Map<string, Map<string, AgentAccessGrantEdge>>()
  for (const grant of params.grants) {
    if (!grant.subjectAgentId) continue
    const inner = agentGrants.get(grant.subjectAgentId) ?? new Map<string, AgentAccessGrantEdge>()
    inner.set(grant.targetAgentId, {
      id: grant.id,
      canView: grant.canView,
      canAddress: grant.canAddress,
    })
    agentGrants.set(grant.subjectAgentId, inner)
  }

  const seeds = params.agents
    .filter(
      (agent) =>
        connectionState({
          tenantId: params.tenantId,
          agents: params.agents,
          grants: params.grants,
          subject: params.subject,
          targetAgentId: agent.id,
          verb: 'address',
          subjectIsTenantAdmin: params.subjectIsTenantAdmin,
        }).allowed,
    )
    .map((agent) => agent.id)

  return reachableAgentIds({
    seedAgentIds: seeds,
    nodes,
    agentGrants,
    tenantId: params.tenantId,
  })
}
