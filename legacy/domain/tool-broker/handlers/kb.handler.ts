import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const KB_TOOLS = new Set(['kb_search', 'kb_list_index', 'kb_get_page'])

/**
 * Tudásbázis retrieval + navigáció (kb_search / kb_list_index / kb_get_page).
 * Az agent-scope (linkelt KB-connectorok uniója) feloldása és az OKF-chunk
 * összeszerelés a keret `kbSearch`/`kbListIndex`/`kbGetPage` metódusaiban él,
 * hogy elkerüljük a broker → registry → handler → broker érték-import ciklust.
 */
export const kbHandler: ToolHandler = {
  id: 'kb',
  handles(tool) {
    return KB_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization }: ToolHandlerArgs) {
    if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
    if (input.tool === 'kb_search') return ctx.kbSearch(input.agentId, input.args, authorization.connector)
    if (input.tool === 'kb_list_index') return ctx.kbListIndex(input.agentId, input.args, authorization.connector)
    if (input.tool === 'kb_get_page') return ctx.kbGetPage(input.agentId, input.args, authorization.connector)
    throw new Error(`Unknown kb tool: ${input.tool}`)
  },
}
