import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * board_write — a ticket-tulajdon kapuja (a ticket az adott agenté-e) a
 * KERETBEN (invoke) dől el, mielott ide jut. A state-machine-alapú állapotváltás
 * + agent-komment a keret `boardWrite` metódusában él.
 */
export const boardWriteHandler: ToolHandler = {
  id: 'board_write',
  handles(tool) {
    return tool === 'board_write'
  },
  async execute({ ctx, input }: ToolHandlerArgs) {
    if (input.tool !== 'board_write') throw new Error(`board_write handler received ${input.tool}`)
    return ctx.boardWrite(input)
  },
}
