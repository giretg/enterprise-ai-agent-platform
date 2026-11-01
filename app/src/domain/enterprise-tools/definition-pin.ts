import type { AgentDefinition } from '@/domain/agent-definition'

export type DefinitionPinDeps = {
  findCurrentDefinitionId: (input: {
    tenantId: string
    agentId: string
  }) => Promise<string | null>
}

export type DefinitionPinCheck =
  | { current: true }
  | { current: false; currentDefinitionId: string | null }

export async function checkDefinitionPin(
  deps: DefinitionPinDeps,
  input: { tenantId: string; definition: AgentDefinition },
): Promise<DefinitionPinCheck> {
  const currentDefinitionId = await deps.findCurrentDefinitionId({
    tenantId: input.tenantId,
    agentId: input.definition.agentId,
  })
  if (currentDefinitionId && currentDefinitionId === input.definition.definitionId) {
    return { current: true }
  }
  return { current: false, currentDefinitionId }
}

/**
 * Újrapublikálás munka közben: a régi definitionId-val érkező OLVASÓ hívás az aktuális
 * verzión fut le (annak jogosultságaival), és a válasz jelzi a váltást. Írás továbbra is
 * `agent_stale` — ott az új utasításokat előbb be kell tölteni.
 */
export const DEFINITION_UPDATED_NOTICE =
  'The agent was republished while you were working. This read ran on the current version. Before your next step call platform.agent.get_definition to load the new instructions, and pass currentDefinitionId from now on.'

type TextToolResult = { isError?: true; content: Array<{ type: 'text'; text: string }> }

export function withDefinitionUpdatedNotice<T extends TextToolResult>(
  result: T,
  input: { previousDefinitionId: string; currentDefinitionId: string },
): T {
  const notice = {
    definitionUpdated: {
      previousDefinitionId: input.previousDefinitionId,
      currentDefinitionId: input.currentDefinitionId,
      message: DEFINITION_UPDATED_NOTICE,
    },
  }
  return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify(notice) }] }
}

/** Zod-hiba → a kliensnek és az auditnak is olvasható mezőlista (rövidítve). */
export function invalidArgsDetails(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
}): { issues: Array<{ path: string; message: string }> } {
  return {
    issues: error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message.slice(0, 200),
    })),
  }
}
