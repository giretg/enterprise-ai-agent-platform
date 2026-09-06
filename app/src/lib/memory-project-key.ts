import { effectiveWorkProjectKey } from '@/lib/work-project'

/**
 * Ticket memória-scope (§2.1):
 * - Folyamat-lépés ticket: mindig a ProcessDefinition.id (nem az instance, nem a
 *   ticket alapértelmezett `__general__` projectKey-je).
 * - Ad-hoc ticket: a ticket.projectKey (munka-projekt), különben `__general__`.
 *
 * Az olvasás (GeneralTaskRuntime) és az írás (memory_propose) EZT a függvényt
 * kell használja — különben a két út eltérő kulcsra ír/olvas (csendes adatvesztés).
 */
export async function resolveTicketMemoryProjectKey(params: {
  projectKey?: string | null
  processInstanceId?: string | null
  resolveProcessDefinitionId?: () => Promise<string | null | undefined>
}): Promise<string> {
  if (params.processInstanceId && params.resolveProcessDefinitionId) {
    const definitionId = (await params.resolveProcessDefinitionId())?.trim()
    if (definitionId) return definitionId
  }
  return effectiveWorkProjectKey(params.projectKey)
}
