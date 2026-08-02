import type { Agent, SkillRiskTier } from '@prisma/client'
import type { TenantAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { services } from '@/domain'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import { isTenantAdmin, tenantUserSubject } from '@/domain/agent-access/tenant-user-subject'
import { loadAgentDelegatedConnectors } from '@/lib/agent-delegated-connectors-server'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import { shouldExcludeHiddenAgents } from '@/lib/agent-operator-visibility'
import { prisma } from '@/lib/db'
import type { SkillReadiness } from '@/lib/skill/skill-readiness'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { repositories } from '@/repositories/postgres'
import {
  buildAgentToolAccessReport,
  type AgentToolAccessReport,
} from '@/domain/tool-broker/tool-access-diagnostics'

const DEFAULT_MEMORY_PROJECT_KEY = '__general__'

export type AgentDetailMemoryOverview = Awaited<ReturnType<typeof loadMemoryOverview>>

export type AgentDetailKbInitial = {
  kbDocs: Array<{ id: string; filename: string; status: string; createdAt: Date | string }>
  pendingDocs: Array<{ ticketId: string; documentId: string; filename: string; createdAt: Date | string }>
  sharedWith: Array<{ id: string; name: string }>
  agentOptions: Array<{ id: string; name: string; role: string }>
}

export type AgentDetailSkillRow = {
  agentId: string
  skillVersionId: string
  enabled: boolean
  skillId: string
  name: string
  description: string
  version: number
  riskTier: SkillRiskTier
  requires: Array<{ toolName: string; reason: string }>
  readiness: SkillReadiness
}

export type AgentDetailAssignableSkill = {
  skillId: string
  name: string
  description: string
  riskTier: SkillRiskTier
  activeVersionId: string
  version: number
}

export type AgentDetailPageData = {
  isAdmin: boolean
  canManageKb: boolean
  canApproveKb: boolean
  agent: NonNullable<Awaited<ReturnType<typeof repositories.agents.findByIdForDisplay>>>['agent']
  memoryContent: string | null
  memoryVersion: number | null
  recipe: NonNullable<Awaited<ReturnType<typeof repositories.agents.findByIdForDisplay>>>['recipe']
  resources: NonNullable<Awaited<ReturnType<typeof repositories.agents.findByIdForDisplay>>>['resources']
  apiKeyPreview: string | null
  behaviorProfileLink: NonNullable<
    Awaited<ReturnType<typeof repositories.agents.findByIdForDisplay>>
  >['behaviorProfileLink']
  delegatedConnectors: Awaited<ReturnType<typeof loadAgentDelegatedConnectors>>
  governance: {
    capabilities: Awaited<ReturnType<typeof repositories.toolBroker.findCapabilitiesForAgent>>
    connectors: Awaited<ReturnType<typeof repositories.toolBroker.findConnectorsForAgent>>
    /**
     * issue #194, WP-5 — „látja, de nincs joga" / „van joga, de nem látja".
     * A MÁR betöltött capability-sorokból számol, nincs extra DB-kör.
     */
    toolAccess: AgentToolAccessReport
  } | null
  modelPolicy: Awaited<ReturnType<typeof services.platformSettings.getModelPolicy>> | null
  connectorCatalog: Awaited<ReturnType<typeof services.provisioning.listCatalog>> | null
  behaviorProfiles: Array<{ id: string; name: string; currentVersion: number }>
  agentSkills: AgentDetailSkillRow[]
  assignableSkills: AgentDetailAssignableSkill[]
  memoryPanel: {
    projectKeys: string[]
    initialProjectKey: string
    initialOverview: AgentDetailMemoryOverview
  } | null
  knowledgeBase: AgentDetailKbInitial | null
}

function provisioningActor(ctx: TenantAuthContext): ProvisioningActor {
  return {
    type: 'user',
    userId: ctx.user.id,
    role: ctx.activeTenantRole,
    tenantId: ctx.activeTenantId,
  }
}

function assertAgentReachable(agent: { tenantId: string | null }, tenantId: string) {
  if (!isAgentReachableFromTenant(agent.tenantId, tenantId)) {
    throw new Error('Agent not found')
  }
}

async function loadMemoryProjectKeys(agentId: string, memoryId: string): Promise<string[]> {
  const keys = new Set<string>([DEFAULT_MEMORY_PROJECT_KEY])

  // Egy körös UNION a négy distinct findMany helyett — kevesebb round-trip, ugyanaz a kulcshalmaz.
  const rows = await prisma.$queryRaw<Array<{ project_key: string | null }>>`
    SELECT DISTINCT project_key FROM (
      SELECT project_key FROM conversations WHERE agent_id = ${agentId}::uuid
      UNION ALL
      SELECT project_key FROM memory_chunks WHERE memory_id = ${memoryId}::uuid
      UNION ALL
      SELECT project_key FROM memory_candidates WHERE memory_id = ${memoryId}::uuid
      UNION ALL
      SELECT project_key FROM memory_versions WHERE memory_id = ${memoryId}::uuid
    ) AS keys
    WHERE project_key IS NOT NULL AND btrim(project_key) <> ''
  `

  for (const row of rows) {
    const key = row.project_key?.trim()
    if (key) keys.add(key)
  }

  return [...keys].sort((a, b) => {
    if (a === DEFAULT_MEMORY_PROJECT_KEY) return -1
    if (b === DEFAULT_MEMORY_PROJECT_KEY) return 1
    return a.localeCompare(b, 'hu')
  })
}

async function loadMemoryOverview(memoryId: string, projectKey: string) {
  const workstreamKey = undefined

  const [focus, decisions, openTasks, constraints, artifacts, activeChunks, versions] =
    await Promise.all([
      repositories.memoryChunks.findActiveFocus({ memoryId, projectKey, workstreamKey }),
      repositories.memoryChunks.listActiveByType({
        memoryId,
        projectKey,
        workstreamKey,
        type: 'decision',
        limit: 20,
      }),
      repositories.memoryChunks.listActiveByType({
        memoryId,
        projectKey,
        workstreamKey,
        type: 'open_task',
        limit: 20,
      }),
      repositories.memoryChunks.listActiveByType({
        memoryId,
        projectKey,
        workstreamKey,
        type: 'constraint',
        limit: 20,
      }),
      repositories.memoryChunks.listActiveByType({
        memoryId,
        projectKey,
        workstreamKey,
        type: 'artifact',
        limit: 20,
      }),
      repositories.memoryChunks.listRecentActive({
        memoryId,
        projectKey,
        workstreamKey,
        limit: 100,
      }),
      repositories.memoryVersions.listForScope({
        memoryId,
        projectKey,
        workstreamKey,
        limit: 20,
      }),
    ])

  // Egy lekérdezés projectKey + status IN — a korábbi 3×listByRun + app-oldali filter helyett.
  const pending = await repositories.memoryCandidates.listByRun({
    memoryId,
    projectKey,
    statuses: ['proposed', 'modified', 'ticketed'],
  })

  return {
    projectState: { focus, decisions, openTasks, constraints, artifacts },
    activeChunks,
    candidateQueue: pending.filter((c) => c.proposedBy !== 'maintenance_job'),
    maintenanceProposals: pending.filter((c) => c.proposedBy === 'maintenance_job'),
    versions,
  }
}

async function loadKnowledgeBaseInitial(
  agent: Agent,
  ctx: TenantAuthContext,
  includeAgentOptions: boolean,
): Promise<AgentDetailKbInitial | null> {
  if (agent.role === 'orchestrator') return null
  assertAgentReachable(agent, ctx.activeTenantId)

  const kbConnector = await ensureAgentKnowledgeBase(agent)
  if (!kbConnector) {
    return { kbDocs: [], pendingDocs: [], sharedWith: [], agentOptions: [] }
  }

  const [documents, pending, links, agents] = await Promise.all([
    repositories.documents.findByConnectorId(kbConnector.id),
    services.knowledgeBase.listPendingDocuments(agent.id, ctx.activeTenantId),
    prisma.agentConnector.findMany({
      where: { connectorId: kbConnector.id },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { agent: { name: 'asc' } },
    }),
    includeAgentOptions
      ? repositories.agents.findMany({
          tenantId: ctx.activeTenantId,
          excludeHiddenFromOperators: shouldExcludeHiddenAgents(ctx.activeTenantRole),
        })
      : Promise.resolve([]),
  ])

  return {
    kbDocs: documents,
    pendingDocs: pending,
    sharedWith: links
      .filter((l) => l.agent.id !== agent.id)
      .map((l) => ({ id: l.agent.id, name: l.agent.name })),
    agentOptions: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
  }
}

function mapAgentSkillRows(
  rows: Awaited<ReturnType<typeof services.skills.listAgentSkillsWithReadiness>>,
): AgentDetailSkillRow[] {
  return rows.map((r) => ({
    agentId: r.agentId,
    skillVersionId: r.skillVersionId,
    enabled: r.enabled,
    skillId: r.skillId,
    name: r.name,
    description: r.description,
    version: r.version,
    riskTier: r.riskTier,
    requires: r.requires,
    readiness: r.readiness,
  }))
}

function mapAssignableSkills(
  catalog: Awaited<ReturnType<typeof services.skills.listForActor>>,
  assignedSkillIds: Set<string>,
): AgentDetailAssignableSkill[] {
  const rows: AgentDetailAssignableSkill[] = []
  for (const skill of catalog) {
    const active = skill.versions.find((v) => v.status === 'active')
    if (!active || assignedSkillIds.has(skill.id)) continue
    rows.push({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      riskTier: skill.riskTier,
      activeVersionId: active.id,
      version: active.version,
    })
  }
  return rows
}

/**
 * Agent detail oldal összes adata egy auth stackkel, szerepkör-gate-elt lekérdezésekkel.
 *
 * A gate-ek az AKTÍV tenant-szerepre döntenek, nem a legacy `User.role`-ra (§5.4).
 * Itt ez nem UI-dísz: az alábbi lekérdezések közvetlenül a repository/service rétegre
 * mennek, megkerülve a korábbi per-action `requireTenantRole` kapukat (`getAgentGovernance`
 * = viewer, `getModelPolicy` = operator, `listAssignableSkillsAction` = admin), így az
 * `isAdmin`/`canManageKb` az EGYETLEN authorizációs határ rájuk.
 */
export async function loadAgentDetailPageData(
  agentId: string,
  ctx: TenantAuthContext,
): Promise<AgentDetailPageData> {
  const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canManageKb = hasMinimumRole(ctx.activeTenantRole, 'operator')
  const canApproveKb = hasMinimumRole(ctx.activeTenantRole, 'approver')

  const detail = await repositories.agents.findByIdForDisplay(agentId, ctx.activeTenantId)
  if (!detail) throw new Error('Agent not found')
  // #142 — a detail oldal a gráf `view` döntését használja (nem csak a régi
  // hiddenFromOperators kaput), így közvetlen URL sem fed fel elrejtett agentet.
  const subject = tenantUserSubject(ctx)
  const viewAllowed = subject
    ? (
        await services.agentAccess.canAccessAgent(subject, agentId, 'view', {
          subjectIsTenantAdmin: isTenantAdmin(ctx),
        })
      ).allowed
    : false
  if (!viewAllowed) throw new Error('Agent not found')

  const delegatedConnectors = await loadAgentDelegatedConnectors(
    agentId,
    ctx.user.id,
    ctx.activeTenantId,
  )

  const adminLoads = isAdmin
    ? await Promise.all([
        Promise.all([
          repositories.toolBroker.findCapabilitiesForAgent(agentId),
          repositories.toolBroker.findConnectorsForAgent(agentId),
        ]),
        services.platformSettings.getModelPolicy(),
        services.provisioning.listCatalog(provisioningActor(ctx)),
        repositories.behaviorProfiles.findMany(ctx.activeTenantId),
        services.skills.listAgentSkillsWithReadiness(agentId),
        services.skills.listForActor(ctx.activeTenantId),
      ] as const)
    : null

  let governance: AgentDetailPageData['governance'] = null
  let modelPolicy: AgentDetailPageData['modelPolicy'] = null
  let connectorCatalog: AgentDetailPageData['connectorCatalog'] = null
  let behaviorProfiles: AgentDetailPageData['behaviorProfiles'] = []
  let agentSkills: AgentDetailSkillRow[] = []
  let assignableSkills: AgentDetailAssignableSkill[] = []
  let memoryPanel: AgentDetailPageData['memoryPanel'] = null

  if (adminLoads) {
    const [[capabilities, connectors], policy, catalog, profiles, assignedWithReadiness, skillCatalog] =
      adminLoads

    governance = {
      capabilities,
      connectors,
      toolAccess: buildAgentToolAccessReport(agentId, capabilities),
    }
    modelPolicy = policy
    connectorCatalog = catalog
    behaviorProfiles = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      currentVersion: p.currentVersion,
    }))

    agentSkills = mapAgentSkillRows(assignedWithReadiness)
    const assignedSkillIds = new Set(assignedWithReadiness.map((a) => a.skillId))
    assignableSkills = mapAssignableSkills(skillCatalog, assignedSkillIds)

    const memoryId = detail.agent.memoryId
    const [projectKeys, initialOverview] = await Promise.all([
      loadMemoryProjectKeys(agentId, memoryId),
      loadMemoryOverview(memoryId, DEFAULT_MEMORY_PROJECT_KEY),
    ])
    memoryPanel = {
      projectKeys,
      initialProjectKey: DEFAULT_MEMORY_PROJECT_KEY,
      initialOverview,
    }
  }

  const knowledgeBase =
    canManageKb && detail.agent.role !== 'orchestrator'
      ? await loadKnowledgeBaseInitial(detail.agent, ctx, true)
      : null

  return {
    isAdmin,
    canManageKb,
    canApproveKb,
    agent: detail.agent,
    memoryContent: detail.memoryContent,
    memoryVersion: detail.memoryVersion,
    recipe: detail.recipe,
    resources: detail.resources,
    apiKeyPreview: detail.apiKeyPreview,
    behaviorProfileLink: detail.behaviorProfileLink,
    delegatedConnectors,
    governance,
    modelPolicy,
    connectorCatalog,
    behaviorProfiles,
    agentSkills,
    assignableSkills,
    memoryPanel,
    knowledgeBase,
  }
}
