import { redirect } from 'next/navigation'
import { McpSetupLanding } from '@/components/mcp/mcp-setup-landing'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import { DEFAULT_AGENT_WORKSPACE_FALLBACK } from '@/lib/control-plane-entry'
import { buildMcpClientSetup } from '@/lib/mcp-client-setup'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'

export default async function GetStartedPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const tenant = await repositories.tenants.findById(ctx.activeTenantId)
  if (!tenant) redirect(DEFAULT_AGENT_WORKSPACE_FALLBACK)

  return (
    <McpSetupLanding
      setup={buildMcpClientSetup({
        origin: resolvePublicAppOrigin(),
        tenantSlug: tenant.slug,
      })}
      continueHref={DEFAULT_AGENT_WORKSPACE_FALLBACK}
    />
  )
}
