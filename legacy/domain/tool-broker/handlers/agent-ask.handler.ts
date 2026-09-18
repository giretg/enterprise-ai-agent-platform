import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * agent_ask — agent→agent delegáció. A cél-agent tenant-elérhetoség őre, a
 * szinkron/aszinkron delegáció-feldolgozás és a válasz-visszakötés a keret
 * `agentAsk` metódusában él.
 */
export const agentAskHandler: ToolHandler = {
  id: 'agent_ask',
  handles(tool) {
    return tool === 'agent_ask'
  },
  async execute({ ctx, input, actingTenantId }: ToolHandlerArgs) {
    if (input.tool !== 'agent_ask') throw new Error(`agent_ask handler received ${input.tool}`)
    return ctx.agentAsk(input, actingTenantId)
  },
}
