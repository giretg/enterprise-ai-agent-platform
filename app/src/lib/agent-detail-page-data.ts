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
import {
  AgentDetailLoadError,
  classifyAgentDetailLookup,
} from '@/lib/agent-detail-access'
import { canOpenRunAnalystWorkspace } from '@/lib/run-analysis-entry'
import { logger } from '@/lib/observability/logger'
import {
  loadEfficiencyAdvisorCard,
} from '@/domain/agent/efficiency-advisor-query'
import type { EfficiencyAdvisorView } from '@/domain/agent/efficiency-advisor'

const DEFAULT_MEMORY_PROJECT_KEY = '__general__'

export type AgentDetailMemoryOverview = Awaited<ReturnType<typeof loadMemoryOverview>>

export type AgentDetailKbInitial = {
  kbDocs: Array<{ id: string; filename: string; status: string; createdAt: Date | string }>
  pendingDocs: Array<{
    ticketId: string
    documentId: string
    filename: string
    createdAt: Date | string
    processingMode?: 'raw_text_only' | 'okf' | null
  }>
  sharedWith: Array<{ id: string; name: string }>
  agentOptions: Array<{ id: string; name: string; role: string }>
}

export type AgentDetailSkillRow = {
  agentId: string
  skillVersionId: string
  enabled: boolean
  skillId: string
  name: string
  displayName: string | null
  description: string
  version: number
  riskTier: SkillRiskTier
  requires: Array<{ toolName: string; reason: string }>
  readiness: SkillReadiness
}

export type AgentDetailAssignableSkill = {
  skillId: string
  name: string
  displayName: string | null
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
    projectLabels: Record<string, string>
    initialProjectKey: string
    initialOverview: AgentDetailMemoryOverview
  } | null
  knowledgeBase: AgentDetailKbInitial | null
  efficiencyAdvisor: EfficiencyAdvisorView | null
  /** Másodlagos panelek (memória/KB/governance) hibája — az agent ettől még megjelenik. */
  secondaryError: string | null
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

async function loadMemoryProjectKeys(
  agentId: string,
  memoryId: string,
  tenantId: string | null,
): Promise<{ projectKeys: string[]; projectLabels: Record<string, string> }> {
  const keys = new Set<string>([DEFAULT_MEMORY_PROJECT_KEY])
  const projectLabels: Record<string, string> = {
    [DEFAULT_MEMORY_PROJECT_KEY]: 'Általános (alapértelmezett)',
  }

  const defined = tenantId
    ? await prisma.workProject.findMany({
        where: { tenantId },
        select: { key: true, name: true },
      })
    : []
  for (const row of defined) {
    keys.add(row.key)
    projectLabels[row.key] = row.name
  }

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

  const projectKeys = [...keys].sort((a, b) => {
    if (a === DEFAULT_MEMORY_PROJECT_KEY) return -1
    if (b === DEFAULT_MEMORY_PROJECT_KEY) return 1
    return a.localeCompare(b, 'hu')
  })
  return { projectKeys, projectLabels }
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
    displayName: r.displayName,
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
      displayName: skill.displayName,
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
 * mennek, megkerülve a korábbi per-action `requireTenantRole` kapukat, így az
 * `isAdmin`/`canManageKb` az EGYETLEN authorizációs határ rájuk.
 *
 * View-safe panelek (eszközjogok, kapcsolatok, hozzárendelt skillek) minden
 * viewernek mennek — a régi `getAgentGovernance` viewer-kapuval egyezik.
 * Admin-only: modellpolicy, connector-katalógus, assignable skillek,
 * behavior-profil katalógus, projekt-memória.
 */
export async function loadAgentDetailPageData(
  agentId: string,
  ctx: TenantAuthContext,
): Promise<AgentDetailPageData> {
  const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canManageKb = hasMinimumRole(ctx.activeTenantRole, 'operator')
  const canApproveKb = hasMinimumRole(ctx.activeTenantRole, 'approver')

  const detail = await repositories.agents.findByIdForDisplay(agentId, ctx.activeTenantId)
  if (!detail) {
    const unrestricted = await repositories.agents.findById(agentId)
    const decision = classifyAgentDetailLookup({
      displayed: null,
      unrestricted: unrestricted
        ? { tenantId: unrestricted.tenantId, name: unrestricted.name }
        : null,
      activeTenantId: ctx.activeTenantId,
      membershipTenantIds: new Set(
        ctx.memberships.filter((m) => m.status === 'active').map((m) => m.tenantId),
      ),
    })
    if (decision.status === 'wrong_tenant') {
      throw AgentDetailLoadError.wrongTenant(decision.agentTenantId, decision.agentName)
    }
    throw AgentDetailLoadError.notFound()
  }
  // #142 — a detail oldal a gráf `view` döntését használja (nem csak a régi
  // hiddenFromOperators kaput), így közvetlen URL sem fed fel elrejtett agentet.
  const runAnalystOk = await canOpenRunAnalystWorkspace({
    tenantId: ctx.activeTenantId,
    role: ctx.activeTenantRole,
    userId: ctx.user.id,
    agentId,
  })
  if (!runAnalystOk) {
    const subject = tenantUserSubject(ctx)
    const viewAllowed = subject
      ? (
          await services.agentAccess.canAccessAgent(subject, agentId, 'view', {
            subjectIsTenantAdmin: isTenantAdmin(ctx),
          })
        ).allowed
      : false
    if (!viewAllowed) throw AgentDetailLoadError.noView()
  }

  let delegatedConnectors: AgentDetailPageData['delegatedConnectors'] = []
  let governance: AgentDetailPageData['governance'] = null
  let modelPolicy: AgentDetailPageData['modelPolicy'] = null
  let connectorCatalog: AgentDetailPageData['connectorCatalog'] = null
  let behaviorProfiles: AgentDetailPageData['behaviorProfiles'] = []
  let agentSkills: AgentDetailSkillRow[] = []
  let assignableSkills: AgentDetailAssignableSkill[] = []
  let memoryPanel: AgentDetailPageData['memoryPanel'] = null
  let knowledgeBase: AgentDetailPageData['knowledgeBase'] = null
  let efficiencyAdvisor: EfficiencyAdvisorView | null = null
  let secondaryError: string | null = null

  try {
    delegatedConnectors = await loadAgentDelegatedConnectors(
      agentId,
      ctx.user.id,
      ctx.activeTenantId,
    )

    const [capabilities, connectors, assignedWithReadiness] = await Promise.all([
      repositories.toolBroker.findCapabilitiesForAgent(agentId),
      repositories.toolBroker.findConnectorsForAgent(agentId),
      services.skills.listAgentSkillsWithReadiness(agentId),
    ])

    governance = {
      capabilities,
      connectors,
      toolAccess: buildAgentToolAccessReport(agentId, capabilities),
    }
    agentSkills = mapAgentSkillRows(assignedWithReadiness)

    if (isAdmin) {
      const [policy, catalog, profiles, skillCatalog] = await Promise.all([
        services.platformSettings.getModelPolicy(),
        services.provisioning.listCatalog(provisioningActor(ctx)),
        repositories.behaviorProfiles.findMany(ctx.activeTenantId),
        services.skills.listForActor(ctx.activeTenantId),
      ])

      modelPolicy = policy
      connectorCatalog = catalog
      behaviorProfiles = profiles.map((p) => ({
        id: p.id,
        name: p.name,
        currentVersion: p.currentVersion,
      }))

      const assignedSkillIds = new Set(assignedWithReadiness.map((a) => a.skillId))
      assignableSkills = mapAssignableSkills(skillCatalog, assignedSkillIds)

      const memoryId = detail.agent.memoryId
      const [projectScope, initialOverview] = await Promise.all([
        loadMemoryProjectKeys(agentId, memoryId, detail.agent.tenantId),
        loadMemoryOverview(memoryId, DEFAULT_MEMORY_PROJECT_KEY),
      ])
      memoryPanel = {
        projectKeys: projectScope.projectKeys,
        projectLabels: projectScope.projectLabels,
        initialProjectKey: DEFAULT_MEMORY_PROJECT_KEY,
        initialOverview,
      }
    }

    knowledgeBase =
      canManageKb && detail.agent.role !== 'orchestrator'
        ? await loadKnowledgeBaseInitial(detail.agent, ctx, true)
        : null
  } catch (e) {
    secondaryError = e instanceof Error ? e.message : 'Secondary agent panels failed to load'
    logger.error(
      {
        event: 'agent_detail.secondary_load_failed',
        agentId,
        tenantId: ctx.activeTenantId,
        error: secondaryError,
      },
      'Agent detail secondary panels failed; rendering identity anyway',
    )
  }

  try {
    efficiencyAdvisor = await loadEfficiencyAdvisorCard({
      agentId,
      tenantId: ctx.activeTenantId,
      range: '30d',
    })
  } catch (e) {
    logger.warn(
      {
        event: 'agent_detail.efficiency_advisor_failed',
        agentId,
        tenantId: ctx.activeTenantId,
        error: e instanceof Error ? e.message : String(e),
      },
      'Efficiency advisor card failed; rendering agent detail without it',
    )
  }

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
    efficiencyAdvisor,
    secondaryError,
  }
}
