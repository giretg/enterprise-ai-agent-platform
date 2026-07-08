import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * web_research_request — web-kutatási delegáció a web-egress role-hoz. A
 * kill-switch, a web-egress agent feloldása, a validátor és az audit a keret
 * `webResearchRequest` metódusában él.
 */
export const webResearchHandler: ToolHandler = {
  id: 'web_research_request',
  handles(tool) {
    return tool === 'web_research_request'
  },
  async execute({ ctx, input }: ToolHandlerArgs) {
    if (input.tool !== 'web_research_request') throw new Error(`web_research handler received ${input.tool}`)
    return ctx.webResearchRequest(input)
  },
}
