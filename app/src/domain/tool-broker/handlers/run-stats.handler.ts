import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/** RA-06 — futás-aggregátumok a Futás-elemzőnek (RA-03 szkóp). */
export const runStatsHandler: ToolHandler = {
  id: 'run_stats',
  handles(tool) {
    return tool === 'run_stats'
  },
  async execute({ ctx, input, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'run_stats') {
      throw new Error(`run_stats handler received ${input.tool}`)
    }
    if (!actingTenantId) {
      throw new Error('run_not_found')
    }
    return ctx.runStats(input, actingTenantId, actingUserId)
  },
}
