import type { Connector, ConnectorAccessMode, Skill, SkillVersion } from '@prisma/client'
import { NORMAL_TOOL_CAPABILITY_NAMES } from '@/lib/tool-capability-catalog'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import type {
  AgentDefinitionRepository,
  AgentRepository,
  ConnectorRepository,
  SkillRepository,
} from '@/repositories/interfaces'
import {
  AgentDefinitionService,
  hashSnapshot,
  type AgentDefinitionSnapshot,
} from '@/domain/agent-definition'

export type ScaffoldWarning = { code: string; path: string; message: string }

export type CreateDraftAgentInput = {
  tenantId: string
  actorId: string
  name: string
  roleInstruction: string
  description?: string
  capabilities?: string[]
  skills?: string[]
  connectors?: Array<{ name: string; accessMode?: ConnectorAccessMode }>
}

export type CreateDraftAgentResult = {
  agentId: string
  status: 'draft'
  workingSet: AgentDefinitionSnapshot
  contentHash: string
  warnings: ScaffoldWarning[]
}

export type AgentScaffoldDeps = {
  agents: Pick<
    AgentRepository,
    | 'create'
    | 'findById'
    | 'updateProfile'
    | 'replaceCapabilities'
    | 'upsertConnectorBinding'
    | 'findCapabilitiesForAgent'
    | 'findConnectorsForAgent'
    | 'setCurrentDefinitionVersionId'
    | 'activate'
  >
  versions: Pick<
    AgentDefinitionRepository,
    'create' | 'findById' | 'findByAgentAndVersion' | 'findMaxVersion'
  >
  skills: Pick<SkillRepository, 'findByNameInScope' | 'findById' | 'assign' | 'listEnabledForAgent'>
  connectors: Pick<ConnectorRepository, 'listForTenant' | 'findById'>
  audit?: AuditSink
}

const KNOWN_CAPABILITIES = new Set(NORMAL_TOOL_CAPABILITY_NAMES)

export class AgentScaffoldError extends Error {
  constructor(
    readonly code: 'invalid_args' | 'invalid_state' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'AgentScaffoldError'
  }
}

function trimOrEmpty(value: string): string {
  return value.trim()
}

function activeSkillVersion(skill: { versions: SkillVersion[] }): SkillVersion | null {
  return skill.versions.find((row) => row.status === 'active') ?? null
}

async function resolveSkillByName(
  skills: AgentScaffoldDeps['skills'],
  tenantId: string,
  name: string,
): Promise<{ skill: Skill; version: SkillVersion } | 'unknown' | 'no_active'> {
  const skill =
    (await skills.findByNameInScope(name, tenantId)) ??
    (await skills.findByNameInScope(name, null))
  if (!skill) return 'unknown'
  const withVersions = await skills.findById(skill.id)
  if (!withVersions) return 'unknown'
  const version = activeSkillVersion(withVersions)
  if (!version) return 'no_active'
  return { skill: withVersions, version }
}

function resolveConnectorByName(
  rows: Connector[],
  name: string,
): Connector | 'unknown' | 'not_active' {
  const matches = rows.filter((row) => row.name.toLowerCase() === name.trim().toLowerCase())
  if (matches.length === 0) return 'unknown'
  const active = matches.find((row) => row.lifecycleState === 'active')
  if (active) return active
  return 'not_active'
}

export async function createDraftAgent(
  deps: AgentScaffoldDeps,
  input: CreateDraftAgentInput,
): Promise<CreateDraftAgentResult> {
  const name = trimOrEmpty(input.name)
  const roleInstruction = trimOrEmpty(input.roleInstruction)
  if (!name || !roleInstruction) {
    throw new AgentScaffoldError('invalid_args', 'name and roleInstruction are required')
  }
  const description =
    input.description === undefined
      ? null
      : trimOrEmpty(input.description).length > 0
        ? trimOrEmpty(input.description).slice(0, 2000)
        : null
  if (name.length > 120) {
    throw new AgentScaffoldError('invalid_args', 'name must be at most 120 characters')
  }
  if (roleInstruction.length > 20_000) {
    throw new AgentScaffoldError('invalid_args', 'roleInstruction must be at most 20000 characters')
  }

  const warnings: ScaffoldWarning[] = []
  const keptCapabilities: string[] = []
  for (const cap of input.capabilities ?? []) {
    const toolName = cap.trim()
    if (!toolName) continue
    if (!KNOWN_CAPABILITIES.has(toolName)) {
      warnings.push({
        code: 'UNKNOWN_CAPABILITY',
        path: 'capabilities',
        message: `Unknown capability dropped: ${toolName}`,
      })
      continue
    }
    keptCapabilities.push(toolName)
  }

  const agent = await deps.agents.create({
    name,
    roleInstruction,
    tenantId: input.tenantId,
    status: 'draft',
    ...(description ? { description } : {}),
  })
  await deps.agents.replaceCapabilities(agent.id, [...new Set(keptCapabilities)])

  for (const skillName of input.skills ?? []) {
    const trimmed = skillName.trim()
    if (!trimmed) continue
    const resolved = await resolveSkillByName(deps.skills, input.tenantId, trimmed)
    if (resolved === 'unknown') {
      warnings.push({
        code: 'UNKNOWN_SKILL',
        path: 'skills',
        message: `Unknown skill dropped: ${trimmed}`,
      })
      continue
    }
    if (resolved === 'no_active') {
      warnings.push({
        code: 'UNKNOWN_SKILL',
        path: 'skills',
        message: `Skill has no active version: ${trimmed}`,
      })
      continue
    }
    await deps.skills.assign({
      agentId: agent.id,
      skillVersionId: resolved.version.id,
      assignedById: input.actorId,
    })
  }

  const allConnectors = await deps.connectors.listForTenant(input.tenantId)

  for (const binding of input.connectors ?? []) {
    const trimmed = binding.name.trim()
    if (!trimmed) continue
    const resolved = resolveConnectorByName(allConnectors, trimmed)
    if (resolved === 'unknown') {
      warnings.push({
        code: 'UNKNOWN_CONNECTOR',
        path: 'connectors',
        message: `Unknown connector dropped: ${trimmed}`,
      })
      continue
    }
    if (resolved === 'not_active') {
      warnings.push({
        code: 'CONNECTOR_NOT_ACTIVE',
        path: 'connectors',
        message: `Connector is not active: ${trimmed}`,
      })
      continue
    }
    await deps.agents.upsertConnectorBinding({
      agentId: agent.id,
      connectorId: resolved.id,
      accessMode: binding.accessMode ?? 'read',
    })
  }

  const definitionService = new AgentDefinitionService({
    agents: deps.agents,
    versions: deps.versions,
    skills: deps.skills,
    connectors: deps.connectors,
    audit: deps.audit,
  })
  const workingSet = await definitionService.getWorkingSet({
    agentId: agent.id,
    tenantId: input.tenantId,
  })

  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: input.actorId,
    agentVersion: null,
    action: 'agent.create',
    targetType: 'agent',
    targetId: agent.id,
    modelUsed: null,
    inputRef: name,
    outputRef: 'draft',
    policyDecision: 'created',
    metadata: {
      agentId: agent.id,
      warningCodes: warnings.map((row) => row.code),
      source: 'mcp.agent.create_draft',
    },
    tenantId: input.tenantId,
  })

  return {
    agentId: agent.id,
    status: 'draft',
    workingSet: workingSet.workingSet,
    contentHash: workingSet.contentHash,
    warnings,
  }
}

export type PublishAgentWorkingSetResult = {
  agentId: string
  status: 'active'
  definitionId: string
  version: number
  snapshot: AgentDefinitionSnapshot
  contentHash: string
  activated: boolean
}

export async function publishAgentWorkingSet(
  deps: AgentScaffoldDeps,
  input: { agentId: string; tenantId: string; publishedById: string },
): Promise<PublishAgentWorkingSetResult> {
  const agent = await deps.agents.findById(input.agentId, input.tenantId)
  if (!agent) throw new AgentScaffoldError('not_found', 'Agent not found')
  if (agent.status === 'suspended' || agent.status === 'retired') {
    throw new AgentScaffoldError('invalid_state', `Cannot publish agent in status ${agent.status}`)
  }
  if (agent.status !== 'draft' && agent.status !== 'active') {
    throw new AgentScaffoldError('invalid_state', `Cannot publish agent in status ${agent.status}`)
  }

  const wasDraft = agent.status === 'draft'
  const definitionService = new AgentDefinitionService({
    agents: deps.agents,
    versions: deps.versions,
    skills: deps.skills,
    connectors: deps.connectors,
    audit: deps.audit,
  })
  const published = await definitionService.publishAgentDefinition({
    agentId: input.agentId,
    tenantId: input.tenantId,
    publishedById: input.publishedById,
  })
  if (wasDraft) {
    await definitionService.activateAgent({
      agentId: input.agentId,
      tenantId: input.tenantId,
      actorId: input.publishedById,
    })
  }

  return {
    agentId: input.agentId,
    status: 'active',
    definitionId: published.definitionId,
    version: published.version,
    snapshot: published.snapshot,
    contentHash: hashSnapshot(published.snapshot),
    activated: wasDraft,
  }
}

export function canMcpScaffoldWrite(role: string, assumed: boolean): boolean {
  return role === 'admin' && !assumed
}

export function canMcpScaffoldRead(role: string): boolean {
  return role === 'admin' || role === 'approver'
}
