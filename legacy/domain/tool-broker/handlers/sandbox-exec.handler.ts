import { CodeSandboxService } from '@/domain/code-sandbox/code-sandbox-service'
import { codeSandboxConfigSchema } from '@/domain/code-sandbox/code-sandbox-types'
import { createSandboxProvider } from '@/domain/code-sandbox/http-sandbox-provider'
import type { ToolHandler } from './tool-handler'

export const sandboxExecHandler: ToolHandler = {
  id: 'sandbox_exec',
  handles: (tool) => tool === 'sandbox_exec',
  async execute({ ctx, input, authorization, actingTenantId }) {
    if (input.tool !== 'sandbox_exec')
      throw new Error('sandbox_exec handler mismatch')
    const connector = authorization.connector
    if (!connector)
      throw new Error('sandbox_exec requires connector authorization')
    const scopeKey = input.ticketId ?? input.conversationId
    if (!scopeKey)
      throw new Error('sandbox_exec requires a ticketId or conversationId')
    const tenantId = await ctx.resolveWorkspaceStorageTenantId(
      input,
      actingTenantId,
      connector.tenantId,
    )
    const config = codeSandboxConfigSchema.parse(connector.config)
    const provider = createSandboxProvider(
      config,
      authorization.agentSecretAlias ?? connector.secretAlias,
    )
    return new CodeSandboxService(ctx.fileEditor, provider, config).execute({
      tenantId,
      scopeKey,
      args: input.args,
    })
  },
}
