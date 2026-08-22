import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/** RA-04 / RA-05 — lapozott futás-idővonal és folyamat-nézet a Futás-elemzőnek. */
export const runTraceHandler: ToolHandler = {
  id: 'run_trace',
  handles(tool) {
    return tool === 'run_trace'
  },
  async execute({ ctx, input, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'run_trace') {
      throw new Error(`run_trace handler received ${input.tool}`)
    }
    if (!actingTenantId) {
      throw new Error('run_not_found')
    }
    return ctx.runTrace(input, actingTenantId, actingUserId)
  },
}
