import type {
  SandboxCommitArgs,
  SandboxRequestPromotionArgs,
  SandboxSnapshotArgs,
} from '../tool-broker-service'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const VERSIONING_TOOLS = new Set(['sandbox.commit', 'sandbox.request_promotion', 'sandbox.snapshot'])

/**
 * Sandbox verziózás agent-toolok (SandboxVersioning-Graduation §5). Az agent
 * commitolhat, javasolhat promóciót és `test`-env snapshotot készíthet. A
 * SandboxVersioningService kikényszeríti, hogy az agent SOHA ne promótálhasson,
 * exportálhasson vagy live adathoz nyúljon — ezekhez nincs capability sem (§5.1).
 */
export const sandboxVersioningHandler: ToolHandler = {
  id: 'sandbox_versioning',
  handles(tool) {
    return VERSIONING_TOOLS.has(tool)
  },
  async execute({ ctx, input, actingTenantId }: ToolHandlerArgs) {
    const actor = { agentId: input.agentId, tenantId: actingTenantId, agentVersion: input.agentVersion }

    if (input.tool === 'sandbox.commit') {
      const a = input.args as SandboxCommitArgs
      return ctx.sandboxVersioning.createSandboxCommit(
        {
          projectId: a.projectId,
          files: a.files,
          changeSummary: a.changeSummary,
          createdFromTicketId: a.createdFromTicketId ?? input.ticketId,
        },
        actor,
      )
    }

    if (input.tool === 'sandbox.request_promotion') {
      const a = input.args as SandboxRequestPromotionArgs
      return ctx.sandboxVersioning.requestPromotion({ projectId: a.projectId, reason: a.reason }, actor)
    }

    // sandbox.snapshot — az agentnek KIZÁRÓLAG `test` env (§5.1).
    const a = input.args as SandboxSnapshotArgs
    return ctx.sandboxVersioning.createDataSnapshot({ projectId: a.projectId, env: 'test', label: a.label }, actor)
  },
}
