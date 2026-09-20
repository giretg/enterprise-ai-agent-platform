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
 * memory, session, queue, or Clerk ids.
 */
import { createHash } from 'node:crypto'
import type { Agent, AgentDefinitionVersion, AgentStatus, Prisma } from '@prisma/client'
import type {
  AgentDefinitionRepository,
  AgentRepository,
  SkillRepository,
} from '@/repositories/interfaces'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

export type AgentDefinitionSnapshot = {
  name: string
  roleInstruction: string
  description?: string | null
  skills: Array<{ skillId: string; skillVersionId: string; name: string }>
  connectors: Array<{ connectorId: string; type: string; accessMode: 'read' | 'write' }>
  capabilities: Array<{ toolName: string; allowed: boolean }>
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
    skillVersion: { skillId: string; status: string; skill: { name: string } }
  }>
  connectors: Array<{ connector: { id: string; type: string }; accessMode: 'read' | 'write' }>
  capabilities: Array<{ toolName: string; allowed: boolean }>
}

function buildSnapshot(
  agent: { name: string; roleInstruction: string; description?: string | null },
  workingSet: Pick<DraftWorkingSet, 'enabledSkills' | 'connectors' | 'capabilities'>,
): AgentDefinitionSnapshot {
  return {
    name: agent.name,
    roleInstruction: agent.roleInstruction,
    description: agent.description ?? null,
    skills: workingSet.enabledSkills
      .filter((row) => row.skillVersion.status === 'active')
      .map((row) => ({
        skillId: row.skillVersion.skillId,
        skillVersionId: row.skillVersionId,
        name: row.skillVersion.skill.name,
      })),
    connectors: workingSet.connectors.map((row) => ({
      connectorId: row.connector.id,
      type: row.connector.type,
      accessMode: row.accessMode,
    })),
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
    const draft = buildSnapshot(agent, { enabledSkills, connectors, capabilities })
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

    const [enabledSkills, connectors, capabilities] = await Promise.all([
      this.deps.skills.listEnabledForAgent(agent.id),
      this.deps.agents.findConnectorsForAgent(agent.id),
      this.deps.agents.findCapabilitiesForAgent(agent.id),
    ])

    const snapshot = buildSnapshot(agent, { enabledSkills, connectors, capabilities })

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
