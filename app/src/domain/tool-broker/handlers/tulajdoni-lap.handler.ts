import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * tulajdoni_lap_parse — magyar e-hiteles tulajdoni lap (TULLAP/INYER PDF)
 * strukturált kinyerése. A tartalom-hozzáférés a keret `tulajdoniLapParse`
 * metódusában él, ugyanazon a csatolmány-kapun, mint a `document_read`.
 */
export const tulajdoniLapHandler: ToolHandler = {
  id: 'tulajdoni_lap_parse',
  handles(tool) {
    return tool === 'tulajdoni_lap_parse'
  },
  async execute({ ctx, input, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'tulajdoni_lap_parse') {
      throw new Error(`tulajdoni_lap_parse handler received ${input.tool}`)
    }
    return ctx.tulajdoniLapParse(input, actingUserId)
  },
}
