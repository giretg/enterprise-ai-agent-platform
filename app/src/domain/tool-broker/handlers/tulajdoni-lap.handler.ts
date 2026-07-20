import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * tulajdoni_lap_parse — magyar e-hiteles tulajdoni lap (TULLAP/INYER PDF)
 * strukturált kinyerése. Document UUID vagy workspace path; a tartalom a
 * `tulajdoniLapParse` delegációban él.
 */
export const tulajdoniLapHandler: ToolHandler = {
  id: 'tulajdoni_lap_parse',
  handles(tool) {
    return tool === 'tulajdoni_lap_parse'
  },
  async execute({ ctx, input, authorization, actingUserId, actingTenantId }: ToolHandlerArgs) {
    if (input.tool !== 'tulajdoni_lap_parse') {
      throw new Error(`tulajdoni_lap_parse handler received ${input.tool}`)
    }
    return ctx.tulajdoniLapParse(input, actingUserId, { authorization, actingTenantId })
  },
}
