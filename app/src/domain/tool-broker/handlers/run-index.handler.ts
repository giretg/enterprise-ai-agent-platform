import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/** RA-03 — futás-fejlécek szkóp-feloldással a Futás-elemzőnek. */
export const runIndexHandler: ToolHandler = {
  id: 'run_index',
  handles(tool) {
    return tool === 'run_index'
  },
  async execute({ ctx, input, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'run_index') {
      throw new Error(`run_index handler received ${input.tool}`)
    }
    if (!actingTenantId) {
      throw new Error('run_not_found')
    }
    return ctx.runIndex(input, actingTenantId, actingUserId)
  },
}
