import type { UserRole } from '@prisma/client'
import { findTenantRunAnalystAgent } from '@/domain/agent-access/run-analyst-materialization'
import { decideAuthz } from '@/lib/iam-policy'
import { repositories } from '@/repositories/postgres'

export type RunAnalysisScope =
  | { kind: 'conversation'; conversationId: string; title?: string | null }
  | { kind: 'ticket'; ticketId: string; title?: string | null }
  | { kind: 'process'; processInstanceId: string; processType?: string | null }

/** RA-08: előre kitöltött első üzenet az elemző chatben (szerkeszthető, nem auto-send). */
export function buildRunAnalysisPrefill(scope: RunAnalysisScope): string {
  switch (scope.kind) {
    case 'conversation':
      return scope.title
        ? `Elemezd ezt a beszélgetést (conversationId: ${scope.conversationId}) — „${scope.title}".`
        : `Elemezd ezt a beszélgetést (conversationId: ${scope.conversationId}).`
    case 'ticket':
      return scope.title
        ? `Elemezd ezt a ticketet (ticketId: ${scope.ticketId}) — „${scope.title}".`
        : `Elemezd ezt a ticketet (ticketId: ${scope.ticketId}).`
    case 'process':
      return scope.processType
        ? `Elemezd ezt a folyamat-futást (processInstanceId: ${scope.processInstanceId}) — ${scope.processType}.`
        : `Elemezd ezt a folyamat-futást (processInstanceId: ${scope.processInstanceId}).`
  }
}

export function buildRunAnalysisAgentHref(agentId: string, prefill: string): string {
  const params = new URLSearchParams({ openChat: '1', prefill })
  return `/control-plane/agents/${agentId}?${params.toString()}`
}

export type RunAnalysisEntry = {
  canRunAnalysis: boolean
  runAnalystAgentId: string | null
}

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
