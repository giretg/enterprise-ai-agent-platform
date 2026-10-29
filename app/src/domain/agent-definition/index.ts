/**
 * Immutable Agent Definition.
 *
 * Publish snapshots the agent's draft working set (name, role instruction,
 * enabled active skills, connector bindings, capabilities) into an
 * append-only `AgentDefinitionVersion` row. The stable identifier is the
 * version UUID. Canonical JSON for `contentHash` is SHA-256 of
 * `JSON.stringify` with object keys sorted recursively.
 *
 * Skill versions become `active` on approve (see SkillRepository.approveVersion);
 * the dead `approved` enum value is never written and must not be used as the
 * snapshot gate — otherwise every live skill is silently dropped from checkout.
 *
 * Snapshots never contain secrets, `tokenRef`, `secretAlias`, `modelConfig`,
 * session, queue, or Clerk ids. They may contain published hard/trained rule text.
 */
import {
  hasPlacementOverrides,
  parsePlacementOverrides,
  type PlacementOverrides,
} from '@/lib/agent-knowledge-placement'
import { createHash } from 'node:crypto'
import type { Agent, AgentDefinitionVersion, AgentStatus, Prisma } from '@prisma/client'
import { describeGoogleAccountBinding } from '@/domain/connector/google-account-binding'
import {
  collectSnapshotRules,
  type AgentDefinitionSnapshotRule,
} from '@/domain/agent-definition/snapshot-rules'
import type {
  AgentDefinitionRepository,
  AgentRepository,
  ConnectorRepository,
  SkillRepository,
} from '@/repositories/interfaces'
import type { AuditSink } from '@/lib/audit/types'
import { isWikiAccessLevel, type WikiAccessLevel } from '@/lib/wiki-access'
import { writeAudit } from '@/lib/audit/types'
import { snapshotLocalRoots } from '@/lib/agent-local-roots'
import { describeConnectorCatalog } from '@/domain/connector/catalog-description'
import {
  parseHttpApiConfig,
  summarizeHttpApiEndpoints,
  type HttpApiEndpointSummary,
} from '@/domain/connector/http-api-client'

/** Publish needs a short "when to call me" so MCP clients can pick among teammates. */
export const AGENT_SCOPE_REQUIRED =
  'A közzétételhez add meg a felelősségi kört: mikor ezt a munkatársat hívd.'
export const PUBLIC_AGENT_NOT_PUBLISHABLE = 'A nyilvános asszisztens nem publikálható belső munkatársként.'

export type { AgentDefinitionSnapshotRule, AgentDefinitionRuleSource } from '@/domain/agent-definition/snapshot-rules'
export { collectSnapshotRules, renderSnapshotRulesBriefingBlock, SNAPSHOT_RULES_OVERRIDE_HINT } from '@/domain/agent-definition/snapshot-rules'

export type AgentDefinitionSnapshot = {
  name: string
  roleInstruction: string
  description?: string | null
  /** Befagyasztott megszeghetetlen + betanított szabályok (#660). Hiányzik a régi snapshotokban. */
  rules?: AgentDefinitionSnapshotRule[]
  /** entry: the agent's entry (orchestrating) skill — every new task starts by reading it. */
  skills: Array<{ skillId: string; skillVersionId: string; name: string; entry?: true }>
  connectors: Array<{
    connectorId: string
    /** Admin által adott név — több http_api kötésnél a tool hívásban is használható. */
    name?: string
    type: string
    accessMode: 'read' | 'write'
    /** `http_api`: OpenAPI info / katalógus-összefoglaló, titok nélkül. */
    description?: string | null
    /**
     * `http_api` connectoroknál az engedélyezett végpont-katalógus (path, method,
     * paraméterek) — a hívó félnek enélkül nincs módja kitalálni, mely path-ok
     * engedélyezettek. Hiányzik, ha a connector configja hibás/hiányos (fail-soft).
     */
    endpoints?: HttpApiEndpointSummary[]
    /**
     * #942 (csak `knowledge_base`): wiki-jog, írási mód, gyűjtési fókusz. Az
     * alapértéknél (`read` / `approval` / üres) kimarad, így a korábbi snapshotok
     * contentHash-e változatlan; hiányzó mező = alapérték (fail-closed).
     */
    wikiAccess?: WikiAccessLevel
    wikiWriteMode?: 'approval' | 'direct'
    wikiCollectFocus?: string
    /** #942 D13: csak privát KB-nál jelenik meg (`private_to_user` + tulajdonos). */
    visibility?: 'private_to_user'
    ownerUserId?: string
  }>
  capabilities: Array<{ toolName: string; allowed: boolean }>
  /**
   * Candidate coding folders across machines (#729). Hints, not a grant, not ranked.
   * Omitted when empty so snapshots published before this field keep their contentHash.
   */
  localRoots?: string[]
  /**
   * Mini app útmutató (#967 D12): az agent saját, opcionális készítési útmutatója.
   * Csak a `platform.mini_app.guide` adja vissza (a get_definition nem). Üresen
   * kimarad, így a korábbi snapshotok contentHash-e változatlan.
   */
  miniAppGuide?: string
  /**
   * „Hová mit ments” tábla agentenkénti felülírása (sor-kulcs → saját szabály). Üresen
   * kimarad, így a korábbi snapshotok contentHash-e változatlan.
   */
  placementOverrides?: PlacementOverrides
}

export type AgentDefinition = {
  definitionId: string
  agentId: string
  version: number
  tenantId: string
  status: AgentStatus
  publishedAt: string
  snapshot: AgentDefinitionSnapshot
}

export type AgentDefinitionDeps = {
  agents: Pick<
    AgentRepository,
    | 'findById'
    | 'setCurrentDefinitionVersionId'
    | 'findCapabilitiesForAgent'
    | 'findConnectorsForAgent'
    | 'activate'
  >
  versions: Pick<
    AgentDefinitionRepository,
    'create' | 'findById' | 'findByAgentAndVersion' | 'findMaxVersion'
  >
  skills: Pick<SkillRepository, 'listEnabledForAgent'>
  /** Opcionális: http_api connectorok végpont-katalógusának feloldásához a snapshotban. */
  connectors?: Pick<ConnectorRepository, 'findById'>
  audit?: AuditSink
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortKeys(nested)]))
  }
  return value
}

/** Canonical JSON: recursively sorted object keys, then JSON.stringify. */
export function canonicalizeSnapshot(snapshot: AgentDefinitionSnapshot): string {
  return JSON.stringify(sortKeys(snapshot))
}

export function hashSnapshot(snapshot: AgentDefinitionSnapshot): string {
  return createHash('sha256').update(canonicalizeSnapshot(snapshot)).digest('hex')
}

function asSnapshot(value: Prisma.JsonValue): AgentDefinitionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid agent definition snapshot')
  }
  return value as AgentDefinitionSnapshot
}

function toDefinition(agent: Agent, row: AgentDefinitionVersion): AgentDefinition {
  return {
    definitionId: row.id,
    agentId: row.agentId,
    version: row.version,
    tenantId: agent.tenantId,
    status: agent.status,
    publishedAt: row.publishedAt.toISOString(),
    snapshot: asSnapshot(row.snapshot),
  }
}

type DraftWorkingSet = {
  name: string
  roleInstruction: string
  description?: string | null
  enabledSkills: Array<{
    skillVersionId: string
    entry?: boolean
    skillVersion: { skillId: string; status: string; skill: { name: string } }
  }>
  connectors: Array<{
    connector: {
      id: string
      name: string
      type: string
      visibility?: string | null
      ownerUserId?: string | null
    }
    accessMode: 'read' | 'write'
    wikiAccess?: string | null
    wikiWriteMode?: string | null
    wikiCollectFocus?: string | null
  }>
  capabilities: Array<{ toolName: string; allowed: boolean }>
}

/** #942: a knowledge_base kötés wiki-mezői a snapshotba — csak a nem-alapértékek. */
function knowledgeBaseSnapshotFields(
  row: DraftWorkingSet['connectors'][number],
): Partial<AgentDefinitionSnapshot['connectors'][number]> {
  if (row.connector.type !== 'knowledge_base') return {}
  const access = isWikiAccessLevel(row.wikiAccess) ? row.wikiAccess : 'read'
  const focus = row.wikiCollectFocus?.trim()
  const isPrivate = row.connector.visibility === 'private_to_user' && !!row.connector.ownerUserId
  return {
    ...(access !== 'read' ? { wikiAccess: access } : {}),
    ...(row.wikiWriteMode === 'direct' ? { wikiWriteMode: 'direct' as const } : {}),
    ...(focus ? { wikiCollectFocus: focus.slice(0, 2000) } : {}),
    ...(isPrivate ? { visibility: 'private_to_user' as const, ownerUserId: row.connector.ownerUserId! } : {}),
  }
}

/**
 * `http_api` connector engedélyezett végpontjai a definíció-snapshothoz. Fail-soft:
 * hibás/hiányos configú connectornál (pl. self-updating spec még nincs jóváhagyva)
 * `undefined`-ot ad — nem buktatja el a teljes snapshotot egy connector miatt.
 */
async function resolveHttpApiConnectorMeta(
  connectors: Pick<ConnectorRepository, 'findById'>,
  connectorId: string,
  tenantId: string,
): Promise<{ endpoints?: HttpApiEndpointSummary[]; description?: string | null } | undefined> {
  try {
    const resolved = await connectors.findById(connectorId, tenantId)
    if (!resolved) return undefined
    const parsed = parseHttpApiConfig(resolved.config)
    const catalog = describeConnectorCatalog(resolved.type, resolved.config, null)
    const baseDescription =
      catalog.description ??
      (typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim().slice(0, 500)
        : null)
    // Google Ads / Analytics / Search Console: a cég által kötött fiók — ne találgasson az agent.
    const accountNote = parsed.googleAccount
      ? describeGoogleAccountBinding(parsed.googleAccount.provider, parsed.googleAccount.binding)
      : null
    const description = [baseDescription, accountNote].filter(Boolean).join(' ') || null
    return {
      endpoints: summarizeHttpApiEndpoints(parsed.endpoints),
      ...(description ? { description } : {}),
    }
  } catch {
    return undefined
  }
}

async function buildSnapshot(
  agent: {
    tenantId: string
    name: string
    roleInstruction: string
    description?: string | null
    hardRules?: string
    trainedRules?: string
    localRoots?: string
    miniAppGuide?: string
    placementOverrides?: unknown
  },
  workingSet: Pick<DraftWorkingSet, 'enabledSkills' | 'connectors' | 'capabilities'>,
  connectors?: Pick<ConnectorRepository, 'findById'>,
): Promise<AgentDefinitionSnapshot> {
  const connectorEntries = await Promise.all(
    workingSet.connectors.map(async (row) => {
      const base = {
        connectorId: row.connector.id,
        name: row.connector.name,
        type: row.connector.type,
        accessMode: row.accessMode,
        ...knowledgeBaseSnapshotFields(row),
      }
      if (row.connector.type !== 'http_api' || !connectors) return base
      const meta = await resolveHttpApiConnectorMeta(connectors, row.connector.id, agent.tenantId)
      return meta ? { ...base, ...meta } : base
    }),
  )
  const localRoots = snapshotLocalRoots(agent.localRoots)
  const placementOverrides = parsePlacementOverrides(agent.placementOverrides)
  return {
    name: agent.name,
    roleInstruction: agent.roleInstruction,
    description: agent.description ?? null,
    rules: collectSnapshotRules(agent),
    ...(localRoots ? { localRoots } : {}),
    ...(agent.miniAppGuide?.trim() ? { miniAppGuide: agent.miniAppGuide.trim() } : {}),
    ...(hasPlacementOverrides(placementOverrides) ? { placementOverrides } : {}),
    skills: workingSet.enabledSkills
      .filter((row) => row.skillVersion.status === 'active')
      .map((row) => ({
        skillId: row.skillVersion.skillId,
        skillVersionId: row.skillVersionId,
        name: row.skillVersion.skill.name,
        // Omitted when false so snapshots published before #653 keep their contentHash.
        ...(row.entry ? { entry: true as const } : {}),
      })),
    connectors: connectorEntries,
    capabilities: workingSet.capabilities.map((row) => ({
      toolName: row.toolName,
      allowed: row.allowed,
    })),
  }
}

export class AgentDefinitionService {
  constructor(private readonly deps: AgentDefinitionDeps) {}

  /**
   * Vázlat vs. közzétett verzió: az MCP a publikált snapshotot olvassa, ezért
   * ha a vázlat (név, instrukció, skill, connector-kötés, capability) eltér
   * tőle, az adminnak újra kell publikálnia. Sosem ír, csak összehasonlít.
   */
  async getWorkingSet(input: { agentId: string; tenantId: string }): Promise<{
    agentId: string
    status: AgentStatus
    currentDefinitionId: string | null
    currentVersion: number | null
    stale: boolean
    workingSet: AgentDefinitionSnapshot
    contentHash: string
  }> {
    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    const publishStatus = await this.getPublishStatus(input)
    const [enabledSkills, connectors, capabilities] = await Promise.all([
      this.deps.skills.listEnabledForAgent(agent.id),
      this.deps.agents.findConnectorsForAgent(agent.id),
      this.deps.agents.findCapabilitiesForAgent(agent.id),
    ])
    const workingSet = await buildSnapshot(
      agent,
      { enabledSkills, connectors, capabilities },
      this.deps.connectors,
    )
    return {
      agentId: agent.id,
      status: agent.status,
      currentDefinitionId: publishStatus.definitionId,
      currentVersion: publishStatus.version,
      stale: publishStatus.stale,
      workingSet,
      contentHash: hashSnapshot(workingSet),
    }
  }

  async getPublishStatus(input: {
    agentId: string
    tenantId: string
  }): Promise<{ definitionId: string | null; version: number | null; stale: boolean }> {
    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    if (!agent.currentDefinitionVersionId) return { definitionId: null, version: null, stale: false }
    const row = await this.deps.versions.findById(agent.currentDefinitionVersionId)
    if (!row) return { definitionId: null, version: null, stale: false }
    const [enabledSkills, connectors, capabilities] = await Promise.all([
      this.deps.skills.listEnabledForAgent(agent.id),
      this.deps.agents.findConnectorsForAgent(agent.id),
      this.deps.agents.findCapabilitiesForAgent(agent.id),
    ])
    const draft = await buildSnapshot(
      agent,
      { enabledSkills, connectors, capabilities },
      this.deps.connectors,
    )
    return {
      definitionId: row.id,
      version: row.version,
      stale: hashSnapshot(draft) !== row.contentHash,
    }
  }

  async publishAgentDefinition(input: {
    agentId: string
    tenantId: string
    publishedById: string
  }): Promise<AgentDefinition> {
    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    // #1016 D1/D7: nyilvános asszisztens sosem kerül MCP-re / Hermesbe / platform-chatbe.
    if (agent.kind === 'public') throw new Error(PUBLIC_AGENT_NOT_PUBLISHABLE)
    if (!agent.description?.trim()) throw new Error(AGENT_SCOPE_REQUIRED)

    const [enabledSkills, connectors, capabilities] = await Promise.all([
      this.deps.skills.listEnabledForAgent(agent.id),
      this.deps.agents.findConnectorsForAgent(agent.id),
      this.deps.agents.findCapabilitiesForAgent(agent.id),
    ])

    const snapshot = await buildSnapshot(
      agent,
      { enabledSkills, connectors, capabilities },
      this.deps.connectors,
    )

    const version = (await this.deps.versions.findMaxVersion(agent.id)) + 1
    const row = await this.deps.versions.create({
      agentId: agent.id,
      version,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      contentHash: hashSnapshot(snapshot),
      publishedById: input.publishedById,
    })
    const updated = await this.deps.agents.setCurrentDefinitionVersionId(agent.id, row.id)
    await writeAudit(this.deps.audit, {
      actorType: 'human',
      actorId: input.publishedById,
      agentVersion: version,
      action: 'agent.version',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: null,
      inputRef: row.id,
      outputRef: String(version),
      policyDecision: 'published',
      metadata: { definitionId: row.id, version },
      tenantId: input.tenantId,
    })
    return toDefinition(updated, row)
  }

  async activateAgent(input: {
    agentId: string
    tenantId: string
    actorId: string
  }): Promise<Agent> {
    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    const updated = await this.deps.agents.activate(agent.id)
    await writeAudit(this.deps.audit, {
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'agent.activated',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: null,
      inputRef: agent.status,
      outputRef: 'active',
      policyDecision: 'activated',
      metadata: { definitionId: updated.currentDefinitionVersionId },
      tenantId: input.tenantId,
    })
    return updated
  }

  async loadAgentDefinition(input: {
    tenantId: string
    definitionId?: string
    agentId?: string
    version?: number
  }): Promise<AgentDefinition | null> {
    let row: AgentDefinitionVersion | null = null
    let agent: Agent | null = null

    if (input.definitionId) {
      row = await this.deps.versions.findById(input.definitionId)
      if (!row) return null
      agent = await this.deps.agents.findById(row.agentId)
    } else {
      if (!input.agentId) return null
      agent = await this.deps.agents.findById(input.agentId)
      if (!agent) return null
      if (input.version !== undefined) {
        row = await this.deps.versions.findByAgentAndVersion(agent.id, input.version)
      } else if (agent.currentDefinitionVersionId) {
        row = await this.deps.versions.findById(agent.currentDefinitionVersionId)
      }
    }

    if (!row || !agent) return null
    if (agent.tenantId !== input.tenantId) return null
    return toDefinition(agent, row)
  }
}

export function publishAgentDefinition(
  deps: AgentDefinitionDeps,
  input: { agentId: string; tenantId: string; publishedById: string },
): Promise<AgentDefinition> {
  return new AgentDefinitionService(deps).publishAgentDefinition(input)
}

export function loadAgentDefinition(
  deps: AgentDefinitionDeps,
  input: { tenantId: string; definitionId?: string; agentId?: string; version?: number },
): Promise<AgentDefinition | null> {
  return new AgentDefinitionService(deps).loadAgentDefinition(input)
}

export function isPrivilegedAgentReader(role: string): boolean {
  return role === 'admin' || role === 'approver'
}

/** Admin/approver see every tenant agent; operator/viewer need view|operate. */
export function canReadPublishedAgent(input: {
  role: string
  grant: { accessLevel: string } | null
}): boolean {
  if (isPrivilegedAgentReader(input.role)) return true
  return input.grant?.accessLevel === 'view' || input.grant?.accessLevel === 'operate'
}

/**
 * Tool invoke: admin/approver (including assumed superadmin) bypass;
 * everyone else needs ResourceGrant `operate`. `view` is definition-read only.
 */
export function canOperateAgent(input: {
  role: string
  grant: { accessLevel: string } | null
  assumed?: boolean
}): boolean {
  if (input.assumed) return true
  if (isPrivilegedAgentReader(input.role)) return true
  return input.grant?.accessLevel === 'operate'
}
