import { redirect } from 'next/navigation'
import { McpSetupLanding, type HermesAdminSetup } from '@/components/mcp/mcp-setup-landing'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import { DEFAULT_AGENT_WORKSPACE_FALLBACK } from '@/lib/control-plane-entry'
import { hasMinimumRole } from '@/lib/iam-policy'
import { buildMcpClientSetup } from '@/lib/mcp-client-setup'
import { loadOpenRouterTenantKey, resolveOpenRouterApiKey } from '@/lib/openrouter-tenant-key'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'

/** Ugyanaz a feloldás, mint a Model Gateway-en: tenant-kulcs, különben platform env. */
async function hermesAdminSetup(tenantId: string, currentUserId: string): Promise<HermesAdminSetup> {
  let modelKeyConfigured: boolean | null
  try {
    modelKeyConfigured = Boolean(await resolveOpenRouterApiKey(tenantId, loadOpenRouterTenantKey))
  } catch {
    modelKeyConfigured = null
  }
  const rows = await repositories.tenantMemberships.findByTenantWithUsers(tenantId)
  const members = rows
    .filter((row) => row.status === 'active')
    .map((row) => ({
      userId: row.userId,
      name: row.userName.trim() || row.userEmail,
      email: row.userEmail,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  return {
    modelKeyConfigured,
    members,
    defaultUserId: members.some((row) => row.userId === currentUserId) ? currentUserId : members[0]?.userId,
  }
}

export default async function GetStartedPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const tenant = await repositories.tenants.findById(ctx.activeTenantId)
  if (!tenant) redirect(DEFAULT_AGENT_WORKSPACE_FALLBACK)
  const hermesAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
    ? await hermesAdminSetup(tenant.id, ctx.user.id)
    : undefined

  return (
    <McpSetupLanding
      setup={buildMcpClientSetup({
        origin: resolvePublicAppOrigin(),
        tenantSlug: tenant.slug,
      })}
      continueHref={DEFAULT_AGENT_WORKSPACE_FALLBACK}
      hermesAdmin={hermesAdmin}
    />
  )
}
