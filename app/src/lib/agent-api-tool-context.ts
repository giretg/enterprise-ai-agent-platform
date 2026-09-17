/**
 * Agent API tool-hívás végrehajtási kontextus-kapuja.
 *
 * Az API-kulcs csak az agentet hitelesíti. A ticket- és beszélgetés-azonosító
 * viszont a kérés törzséből érkezik, és a file/workspace eszközök ebből
 * választják ki a tárolási tenantot. Ezért a broker elé, még a tenant-státusz
 * kapu előtt ellenőrizzük, hogy MINDEN megadott kontextus valóban a hívó
 * agenthez tartozik. A futás-analitikai toolok saját `args.ticketId` mezői
 * nem ide tartoznak: azok csak tenanton belüli lekérdezési szűrők, és a Run
 * Analystnak szándékosan más agent futásait is látnia kell. Különben egy
 * ismert idegen végrehajtási azonosító cross-tenant munkaterület-olvasást
 * vagy -írást nyithatna.
 */
import { resolveToolDescriptor } from '@/domain/tool-broker/tool-registry'

export type AgentApiToolContextLookup = {
  findTicketOwner(ticketId: string): Promise<{ agentId: string | null } | null>
  findConversationOwner(conversationId: string): Promise<{ agentId: string } | null>
}

/**
 * A gépi `/api/v1/agent/tools` út csak `mcp` surface toolokat futtathat.
 * A harness kliens ezt már szűri; a szervernek is kell, különben a
 * `chat`-only toolok (pl. `sandbox_exec` + `allowEgress`) megkerülik a
 * chat-loop következmény-kapuját.
 */
export function isAgentApiMcpTool(tool: string): boolean {
  const descriptor = resolveToolDescriptor(tool)
  return Boolean(descriptor?.surfaces.includes('mcp'))
}

export async function isAgentApiToolContextOwnedByAgent(
  input: {
    agentId: string
    /** A hívás minden, workspace-t vagy végrehajtási kontextust választó ticket-referenciája. */
    ticketIds?: readonly string[]
    conversationId?: string
  },
  lookup: AgentApiToolContextLookup,
): Promise<boolean> {
  for (const ticketId of new Set(input.ticketIds ?? [])) {
    const ticket = await lookup.findTicketOwner(ticketId)
    if (ticket?.agentId !== input.agentId) return false
  }

  if (input.conversationId) {
    const conversation = await lookup.findConversationOwner(input.conversationId)
    if (conversation?.agentId !== input.agentId) return false
  }

  return true
}
