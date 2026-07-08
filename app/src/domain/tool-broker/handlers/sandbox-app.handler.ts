import type {
  SandboxAppCreateArgs,
  SandboxAppExportArgs,
  SandboxAppGetArgs,
  SandboxAppListArgs,
  SandboxAppPreviewArgs,
  SandboxAppUpdateArtifactArgs,
} from '../tool-broker-service'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * Sandbox App agent-toolok (sandbox_app.*). Az `actor` mindig az agent + a
 * cselekvő tenant; a SandboxAppService kényszeríti ki a governance-t.
 */
export const sandboxAppHandler: ToolHandler = {
  id: 'sandbox_app',
  handles(tool) {
    return tool.startsWith('sandbox_app.')
  },
  async execute({ ctx, input, actingTenantId }: ToolHandlerArgs) {
    const actor = { agentId: input.agentId, tenantId: actingTenantId }

    if (input.tool === 'sandbox_app.create') {
      const a = input.args as SandboxAppCreateArgs
      return ctx.sandboxApps.createSandboxApp(
        {
          name: a.name,
          description: a.description,
          criticality: a.criticality ?? 'L1',
          createdFromTicketId: a.createdFromTicketId ?? input.ticketId,
          createdFromConversationId: input.conversationId,
        },
        actor,
      )
    }

    if (input.tool === 'sandbox_app.update_artifact') {
      const a = input.args as SandboxAppUpdateArtifactArgs
      const result = await ctx.sandboxApps.upsertSandboxAppVersion(
        {
          appId: a.appId,
          html: a.html,
          changeSummary: a.changeSummary,
          activate: a.activate ?? true,
          sourceTicketId: input.ticketId,
        },
        actor,
      )
      const { validationResult, ...safe } = result
      return {
        ...safe,
        validationResult: {
          status: (validationResult as { status?: string }).status,
          warnings: (validationResult as { warnings?: string[] }).warnings ?? [],
        },
      }
    }

    if (input.tool === 'sandbox_app.preview') {
      const a = input.args as SandboxAppPreviewArgs
      return ctx.sandboxApps.getSandboxAppPreviewUrl({ appId: a.appId, version: a.version }, actor)
    }

    if (input.tool === 'sandbox_app.export') {
      const a = input.args as SandboxAppExportArgs
      return ctx.sandboxApps.exportSandboxApp({ appId: a.appId, version: a.version }, actor)
    }

    if (input.tool === 'sandbox_app.list') {
      const a = input.args as SandboxAppListArgs
      // Csak a hívó agent SAJÁT mini-appjait listázza — "milyen mini-appjaid vannak" jellegű kérdésre.
      return ctx.sandboxApps.listSandboxApps(
        { createdByAgentId: input.agentId, search: a.search, status: a.status, limit: a.limit ?? 20 },
        actor,
      )
    }

    if (input.tool === 'sandbox_app.get') {
      const a = input.args as SandboxAppGetArgs
      return ctx.sandboxApps.getSandboxAppSource({ appId: a.appId, version: a.version }, actor)
    }

    throw new Error(`Unknown sandbox_app tool: ${(input as { tool: string }).tool}`)
  },
}
