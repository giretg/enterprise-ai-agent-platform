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
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">{t('loading')}</p>}>
      <div className="space-y-6">
        <ProvisioningPanel
          canManageCatalog={isSuper || isTenantAdmin}
          isSuperadmin={isSuper}
          activeTenantId={ctx?.kind === 'tenant' ? ctx.activeTenantId : null}
        />
        {mcp ? (
          <McpConnectorsPanel
            canManage={isSuper || isTenantAdmin}
            initial={mcp.success ? (mcp.data as McpConnectorsData) : null}
            initialError={mcp.success ? undefined : mcp.error}
          />
        ) : null}
      </div>
    </Suspense>
  )
}
