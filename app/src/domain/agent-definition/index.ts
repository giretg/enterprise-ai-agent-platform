/**
 * Immutable Agent Definition.
 *
 * Publish snapshots the agent's draft working set (name, role instruction,
 * enabled approved skills, connector bindings, capabilities) into an
 * append-only `AgentDefinitionVersion` row. The stable identifier is the
 * version UUID. Canonical JSON for `contentHash` is SHA-256 of
 * `JSON.stringify` with object keys sorted recursively.
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

export type AgentDefinitionSnapshot = {
  name: string
  roleInstruction: string
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
  >
  versions: Pick<
    AgentDefinitionRepository,
    'create' | 'findById' | 'findByAgentAndVersion' | 'findMaxVersion'
  >
  skills: Pick<SkillRepository, 'listEnabledForAgent'>
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

export class AgentDefinitionService {
  constructor(private readonly deps: AgentDefinitionDeps) {}

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

    const snapshot: AgentDefinitionSnapshot = {
      name: agent.name,
      roleInstruction: agent.roleInstruction,
      skills: enabledSkills
        .filter((row) => row.skillVersion.status === 'approved')
        .map((row) => ({
          skillId: row.skillVersion.skillId,
          skillVersionId: row.skillVersionId,
          name: row.skillVersion.skill.name,
        })),
      connectors: connectors.map((row) => ({
        connectorId: row.connector.id,
        type: row.connector.type,
        accessMode: row.accessMode,
      })),
      capabilities: capabilities.map((row) => ({
        toolName: row.toolName,
        allowed: row.allowed,
      })),
    }

    const version = (await this.deps.versions.findMaxVersion(agent.id)) + 1
    const row = await this.deps.versions.create({
      agentId: agent.id,
      version,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      contentHash: hashSnapshot(snapshot),
      publishedById: input.publishedById,
    })
    const updated = await this.deps.agents.setCurrentDefinitionVersionId(agent.id, row.id)
    return toDefinition(updated, row)
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
