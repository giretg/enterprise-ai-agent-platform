import { prisma } from '@/lib/db'

/** A cég saját rendszerei — a tudásbázis és a sandbox agentenként magától jön létre, az nem számít. */
export const COMPANY_CONNECTOR_TYPES: readonly string[] = ['google_drive', 'http_api', 'gmail']

/** Bármelyik azt jelenti, hogy a user MCP-kliense hitelesítve elérte a szervert (mcp-principal.ts). */
const MCP_USE_ACTIONS = ['mcp.auth.ok', 'mcp.tools.call']

export type OnboardingStepKey = 'connectors' | 'agents' | 'mcp'
export type OnboardingStep = { key: OnboardingStepKey; done: boolean }

/**
 * A használatba vétel lépései. Admin: rendszerek összekötése → munkatárs → saját MCP.
 * Más szerep nem köt be rendszert és nem vesz fel munkatársat, neki csak a saját MCP-je.
 */
export function onboardingSteps(input: {
  isAdmin: boolean
  companyConnectorCount: number
  agentCount: number
  mcpUsed: boolean
}): OnboardingStep[] {
  const mcp: OnboardingStep = { key: 'mcp', done: input.mcpUsed }
  if (!input.isAdmin) return [mcp]
  return [
    { key: 'connectors', done: input.companyConnectorCount > 0 },
    { key: 'agents', done: input.agentCount > 0 },
    mcp,
  ]
}

/** userId → utolsó MCP-használat. `userId` nélkül a teljes tenant (admin-nézet). */
export async function lastMcpUseByUser(tenantId: string, userId?: string): Promise<Map<string, Date>> {
  // ponytail: groupBy a tenant összes MCP audit-során; ha lassú, last_mcp_use_at oszlop a tagságon.
  const rows = await prisma.auditLog.groupBy({
    by: ['actorId'],
    where: {
      tenantId,
      action: { in: MCP_USE_ACTIONS },
      actorType: 'human',
      ...(userId ? { actorId: userId } : { actorId: { not: null } }),
    },
    _max: { createdAt: true },
  })
  const result = new Map<string, Date>()
  for (const row of rows) {
    if (row.actorId && row._max.createdAt) result.set(row.actorId, row._max.createdAt)
  }
  return result
}
