import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const DIRECTORY_TOOLS = new Set(['agent_resolve', 'agent_catalog', 'user_directory'])

/**
 * Névsor-/katalógus lekérdezések (agent_resolve, agent_catalog, user_directory).
 * A caller tenantja tenant-scope-ot ad; a szurés a keret metódusaiban
 * (`agentResolve`/`agentCatalog`/`userDirectory`) fail-closed módon fut.
 */
export const agentDirectoryHandler: ToolHandler = {
  id: 'agent_directory',
  handles(tool) {
    return DIRECTORY_TOOLS.has(tool)
  },
  async execute({ ctx, input, actingTenantId }: ToolHandlerArgs) {
    if (input.tool === 'agent_resolve') {
      return ctx.agentResolve(input.args, await ctx.resolveCallerTenantId(input, actingTenantId))
    }
    if (input.tool === 'agent_catalog') {
      return ctx.agentCatalog(input.args, await ctx.resolveCallerTenantId(input, actingTenantId))
    }
    if (input.tool === 'user_directory') {
      return ctx.userDirectory(input, actingTenantId)
    }
    throw new Error(`Unknown directory tool: ${input.tool}`)
  },
}
