import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const REPO_TOOLS = new Set(['repo_prepare', 'repo_open_pull_request'])

/**
 * GitHub workspace eszközök (repo_prepare, repo_open_pull_request). A repo-cél
 * feloldás, a GitHub token-feloldás és a commit/branch/PR-nyitás a keret
 * `repoPrepare`/`repoOpenPullRequest` metódusaiban él.
 */
export const repoHandler: ToolHandler = {
  id: 'repo',
  handles(tool) {
    return REPO_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization, actingTenantId }: ToolHandlerArgs) {
    if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
    if (input.tool === 'repo_prepare') {
      return ctx.repoPrepare(input, authorization.connector, actingTenantId)
    }
    if (input.tool === 'repo_open_pull_request') {
      return ctx.repoOpenPullRequest(input, authorization.connector, actingTenantId)
    }
    throw new Error(`Unknown repo tool: ${input.tool}`)
  },
}
