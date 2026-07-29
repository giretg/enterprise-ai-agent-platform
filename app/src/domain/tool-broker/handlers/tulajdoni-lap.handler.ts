import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * tulajdoni_lap_parse — magyar e-hiteles tulajdoni lap (TULLAP/INYER PDF)
 * strukturált kinyerése. Document UUID (extraction / extractedText) vagy
 * workspace path (PDF bináris vagy materializált `.pdf.txt`); a tartalom a
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

/**
 * tulajdoni_lap_egyeztetes — egy hívásban parse + párosítás + munkafüzet
 * (issue #161). Ugyanaz a forrás-feloldás, mint a parse-nál; a kimenet a
 * munkaterületre íródik, ezért a jogosultsága workspace-írás.
 */
export const tulajdoniLapEgyeztetesHandler: ToolHandler = {
  id: 'tulajdoni_lap_egyeztetes',
  handles(tool) {
    return tool === 'tulajdoni_lap_egyeztetes'
  },
  async execute({ ctx, input, authorization, actingUserId, actingTenantId }: ToolHandlerArgs) {
    if (input.tool !== 'tulajdoni_lap_egyeztetes') {
      throw new Error(`tulajdoni_lap_egyeztetes handler received ${input.tool}`)
    }
    return ctx.tulajdoniLapEgyeztetes(input, actingUserId, { authorization, actingTenantId })
  },
}
