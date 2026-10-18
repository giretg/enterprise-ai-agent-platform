import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { isSuperadmin } from '@/lib/tenant-policy'
import { ProvisioningPanel } from './provisioning-panel'
import { McpConnectorsPanel, type McpConnectorsData } from './mcp-connectors-panel'
import { listMcpConnectors } from '@/app/actions/mcp-connectors'

export default async function ProvisioningPage() {
  const ctx = await getAuthContext()
  const isSuper = Boolean(ctx && isSuperadmin(ctx.platformRoles))
  const isTenantAdmin = ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin'
  const t = await getTranslations('Common')
  const mcp = ctx?.kind === 'tenant' ? await listMcpConnectors() : null
  const mcpInitial = mcp?.success ? (mcp.data as McpConnectorsData) : null
  const mcpPanelKey =
    mcpInitial?.connectors
      .map((row) => {
        const tools = [...(row.active?.tools ?? []), ...(row.proposed?.tools ?? [])]
          .map((tool) => `${tool.name}:${tool.risk}:${tool.approved}`)
          .join(',')
        return `${row.id}:${row.active?.versionId ?? ''}:${row.proposed?.versionId ?? ''}:${tools}`
      })
      .join('|') ?? 'mcp-unavailable'
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">{t('loading')}</p>}>
      <div className="space-y-6">
        <ProvisioningPanel
          canManageCatalog={isSuper || isTenantAdmin}
          canManageMcp={Boolean(mcp) && (isSuper || isTenantAdmin)}
          isSuperadmin={isSuper}
          activeTenantId={ctx?.kind === 'tenant' ? ctx.activeTenantId : null}
          mcpInitial={mcpInitial}
          mcpInitialError={mcp && !mcp.success ? mcp.error : undefined}
        />
        {mcp ? (
          <McpConnectorsPanel
            key={mcpPanelKey}
            canManage={isSuper || isTenantAdmin}
            initial={mcp.success ? (mcp.data as McpConnectorsData) : null}
            initialError={mcp.success ? undefined : mcp.error}
          />
        ) : null}
      </div>
    </Suspense>
  )
}
