import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * memory_propose — agent-memory-persistent-cross-conversation-spec.md §6.1.
 * A T1 `MemoryCandidate` létrehozás (scope-feloldás, acceptance-policy, audit)
 * a keret `memoryPropose` metódusában él; a handler csak delegál.
 */
export const memoryProposeHandler: ToolHandler = {
  id: 'memory_propose',
  handles(tool) {
    return tool === 'memory_propose'
  },
  async execute({ ctx, input, actingTenantId }: ToolHandlerArgs) {
    if (input.tool !== 'memory_propose') throw new Error(`memory_propose handler received ${input.tool}`)
    return ctx.memoryPropose(input, actingTenantId)
  },
}
