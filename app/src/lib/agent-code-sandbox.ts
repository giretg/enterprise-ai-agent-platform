import type { Agent, Connector, Prisma } from '@prisma/client'
import type { AgentRepository, ConnectorRepository } from '@/repositories/interfaces'
import { SANDBOX_RUN_TOOL } from '@/domain/enterprise-tools/tool-definitions'
import { codeSandboxConfigSchema } from '@/domain/code-sandbox/code-sandbox-types'

export function codeSandboxConnectorName(): string {
  return 'code_sandbox'
}

export function toolsNeedCodeSandbox(toolNames: string[]): boolean {
  return toolNames.includes(SANDBOX_RUN_TOOL)
}

export function platformCodeSandboxConfig(): Prisma.InputJsonValue | null {
  const cloudRun = process.env.CODE_SANDBOX_CLOUD_RUN_URL?.trim()
  const e2b = process.env.CODE_SANDBOX_E2B_BASE_URL?.trim()
  const region = process.env.CODE_SANDBOX_REGION?.trim() || 'europe-west1'
  const parsed = cloudRun
    ? codeSandboxConfigSchema.safeParse({
        provider: 'cloud_run',
        region,
        baseUrl: cloudRun,
        defaultAllowEgress: false,
      })
    : e2b
      ? codeSandboxConfigSchema.safeParse({
          provider: 'e2b_compatible',
          region,
          baseUrl: e2b,
          defaultAllowEgress: false,
        })
      : null
  return parsed?.success ? parsed.data : null
}

export async function ensureAgentCodeSandbox(
  agent: Pick<Agent, 'id' | 'name' | 'tenantId'>,
  deps: {
    connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName' | 'create'>
    agents: Pick<AgentRepository, 'upsertConnectorBinding'>
  },
): Promise<Connector | null> {
  const config = platformCodeSandboxConfig()
  if (!config) return null
  const name = codeSandboxConnectorName()
  const existing = await deps.connectors.findByTenantTypeAndName(agent.tenantId, 'code_sandbox', name)
  const connector =
    existing ??
    (await deps.connectors.create({
      tenantId: agent.tenantId,
      type: 'code_sandbox',
      name,
      authMode: 'service',
      scope: 'single',
      config,
    }))
  await deps.agents.upsertConnectorBinding({
    agentId: agent.id,
    connectorId: connector.id,
    accessMode: 'write',
  })
  return connector
}
