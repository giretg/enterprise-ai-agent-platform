import { CodeSandboxService, type SandboxRunResult } from '@/domain/code-sandbox/code-sandbox-service'
import { codeSandboxConfigSchema } from '@/domain/code-sandbox/code-sandbox-types'
import { createSandboxProvider } from '@/domain/code-sandbox/http-sandbox-provider'
import type { LiveConnectorRow } from '../authorize-tool-call'

export type SandboxRunExecutionInput = {
  tenantId: string
  scopeKey: string
  command: string[]
  files: Array<{ sandboxPath: string; bytes: Uint8Array }>
}

export async function executeSandboxRun(
  input: SandboxRunExecutionInput,
  connector: LiveConnectorRow,
): Promise<SandboxRunResult> {
  const config = codeSandboxConfigSchema.parse(connector.config)
  const provider = createSandboxProvider(config, connector.secretAlias ?? null)
  return new CodeSandboxService(provider, config).execute(input)
}
