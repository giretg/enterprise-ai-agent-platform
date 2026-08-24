import 'server-only'

import type { UserRole } from '@prisma/client'
import {
  ensureTenantRunAnalystAgent,
  findTenantRunAnalystAgent,
  materializeRunAnalystAdminGrants,
} from '@/domain/agent-access/run-analyst-materialization'
import { decideAuthz } from '@/lib/iam-policy'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import type { RunAnalysisEntry } from '@/lib/run-analysis-shared'
import { repositories } from '@/repositories/postgres'

/** Szerver-oldali belépési pont: `analysis.run` + materializált Futás-elemző agent. */
export async function resolveRunAnalysisEntry(input: {
  tenantId: string
  role: UserRole
  /** Admin belépéskor: régi tenantoknál pótolja a Futás-elemző materializációt. */
  userId?: string
}): Promise<RunAnalysisEntry> {
  const permEntry = await repositories.rolePermissions.findByKey('analysis.run')
  const decision = decideAuthz({ status: 'active', role: input.role }, permEntry?.minRole ?? null)
  if (!decision.allow) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  let agent = await findTenantRunAnalystAgent(input.tenantId)
  if (!agent && input.userId) {
    try {
      agent = await ensureTenantRunAnalystAgent({
        tenantId: input.tenantId,
        approvedById: input.userId,
      })
    } catch {
      agent = await findTenantRunAnalystAgent(input.tenantId)
    }
  }
  if (!agent) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  if (input.userId) {
    try {
      await materializeRunAnalystAdminGrants({
        tenantId: input.tenantId,
        actorUserId: input.userId,
        userId: input.userId,
      })
    } catch {
      // fail-soft: a chat belépés nem bukhat grant-pótláson
    }
  }
  return { canRunAnalysis: true, runAnalystAgentId: agent.id }
}

/** Futás-elemző workspace/chat megnyitása — felülírja a gráf `view` kapuját az Elemezd útvonalon. */
export async function canOpenRunAnalystWorkspace(input: {
  tenantId: string
  role: UserRole
  userId: string
  agentId: string
}): Promise<boolean> {
  const row = await repositories.agents.findById(input.agentId, input.tenantId)
  if (!row || row.systemRole !== RUN_ANALYST_SYSTEM_ROLE) return false
  const entry = await resolveRunAnalysisEntry(input)
  return entry.canRunAnalysis && entry.runAnalystAgentId === input.agentId
}
