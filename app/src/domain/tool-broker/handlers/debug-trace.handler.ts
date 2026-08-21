import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/** APG-21 — pszeudonimizált agent-turn trace a debugging AI számára. */
export const debugTraceHandler: ToolHandler = {
  id: 'get_debug_trace',
  handles(tool) {
    return tool === 'get_debug_trace'
  },
  async execute({ ctx, input, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'get_debug_trace') {
      throw new Error(`get_debug_trace handler received ${input.tool}`)
    }
    return ctx.getDebugTrace(input, actingTenantId, actingUserId)
  },
}
