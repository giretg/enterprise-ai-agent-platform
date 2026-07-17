import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * document_read — csatolmány / Document oldal- és keresés-alapú olvasás.
 * A tartalom-hozzáférés a keret `documentRead` metódusában él.
 */
export const documentReadHandler: ToolHandler = {
  id: 'document_read',
  handles(tool) {
    return tool === 'document_read'
  },
  async execute({ ctx, input, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'document_read') throw new Error(`document_read handler received ${input.tool}`)
    return ctx.documentRead(input, actingUserId)
  },
}
