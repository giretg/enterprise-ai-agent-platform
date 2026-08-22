import 'server-only'

import type { UserRole } from '@prisma/client'
import { findTenantRunAnalystAgent } from '@/domain/agent-access/run-analyst-materialization'
import { decideAuthz } from '@/lib/iam-policy'
import type { RunAnalysisEntry } from '@/lib/run-analysis-shared'
import { repositories } from '@/repositories/postgres'

/** Szerver-oldali belépési pont: `analysis.run` + materializált Futás-elemző agent. */
export async function resolveRunAnalysisEntry(input: {
  tenantId: string
  role: UserRole
}): Promise<RunAnalysisEntry> {
  const permEntry = await repositories.rolePermissions.findByKey('analysis.run')
  const decision = decideAuthz({ status: 'active', role: input.role }, permEntry?.minRole ?? null)
  if (!decision.allow) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  const agent = await findTenantRunAnalystAgent(input.tenantId)
  if (!agent) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  return { canRunAnalysis: true, runAnalystAgentId: agent.id }
}
