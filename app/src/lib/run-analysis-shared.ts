import { agentWorkspacePath } from '@/lib/agent-workspace-routes'

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

/** Agent workspace chat — nem a régi adatlap URL (a Futás-elemző ott 404). */
export function buildRunAnalysisAgentHref(agentId: string, prefill: string): string {
  const params = new URLSearchParams({ prefill })
  return `${agentWorkspacePath(agentId, 'chat')}?${params.toString()}`
}

/** A teljes „Elemezd" útvonal egy szkópból — minden belépési pont ezt hívja. */
export function buildRunAnalysisHref(agentId: string, scope: RunAnalysisScope): string {
  return buildRunAnalysisAgentHref(agentId, buildRunAnalysisPrefill(scope))
}

export type RunAnalysisEntry = {
  canRunAnalysis: boolean
  runAnalystAgentId: string | null
}
