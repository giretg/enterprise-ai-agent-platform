import { getAuthContext } from '@/auth/context'
import {
  getDatabaseMode,
  getDispatcherControls,
  getModelCallsSummary,
  getModelPolicy,
  listModelBudgets,
  listModelRoutingPolicies,
} from '@/app/actions/platform'
import { getMonitorControls } from '@/app/actions/monitor'
import {
  getWebFetchControls,
  getWebSearchControls,
  getWebSearchPolicy,
} from '@/app/actions/web-search'
import { DatabaseControlPanel } from '@/app/control-plane/system/database-control-panel'
import { DispatcherControlPanel } from '@/app/control-plane/system/dispatcher-control-panel'
import { ModelGatewayPanel } from '@/app/control-plane/system/model-gateway-panel'
import { ModelPolicyPanel } from '@/app/control-plane/system/model-policy-panel'
import { MonitorControlPanel } from '@/app/control-plane/system/monitor-control-panel'
import { WebSearchControlPanel } from '@/app/control-plane/system/web-search-control-panel'
import { WebFetchControlPanel } from '@/app/control-plane/system/web-fetch-control-panel'

/**
 * Platform-globális beállítások (Tenant-Management §9.2, §13/4). A dispatcher
 * kill-switch, DB-környezet, model policy/gateway/routing/budget és a web-fetch/
 * web-search vezérlők NEM tenant-adat — csak platform-szerep szerkesztheti. A
 * WRITE-actionök `requirePlatformRole('superadmin')` alatt vannak; a `canEdit`
 * itt ugyanezt tükrözi, hogy a tenant-admin csak read-only nézetet kapjon.
 */
export default async function PlatformSettingsPage() {
  const [
    ctx,
    controlsRes,
    dbModeRes,
    modelPolicyRes,
    monitorControlsRes,
    webSearchControlsRes,
    webSearchPolicyRes,
    webFetchControlsRes,
    gatewayStatsRes,
    routingPoliciesRes,
    budgetsRes,
  ] = await Promise.all([
    getAuthContext(),
    getDispatcherControls(),
    getDatabaseMode(),
    getModelPolicy(),
    getMonitorControls(),
    getWebSearchControls(),
    getWebSearchPolicy(),
    getWebFetchControls(),
    getModelCallsSummary(),
    listModelRoutingPolicies(),
    listModelBudgets(),
  ])
  const isPlatform = Boolean(
    ctx && (ctx.platformRoles.includes('superadmin') || ctx.platformRoles.includes('platform_operator')),
  )
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))

  if (!isPlatform) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Beállítások</h1>
        </header>
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          Ehhez a felülethez platform-szintű jogosultság (superadmin / platform operator) szükséges.
          A tenant-szintű beállítások a tenant admin felületén érhetők el.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Platform-beállítások</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Platform-globális vezérlők: dispatcher kill-switch, adatbázis-környezet, model policy /
          gateway / routing / budget, valamint a web-egress (web-fetch / web-search) kapcsolók.
          Ezek minden tenantra hatnak — kizárólag platform-szerep szerkesztheti.
        </p>
      </header>

      {dbModeRes.success && <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />}
      {controlsRes.success && <DispatcherControlPanel initial={controlsRes.data} canEdit={canEdit} />}
      {monitorControlsRes.success && (
        <MonitorControlPanel initial={monitorControlsRes.data} canEdit={canEdit} />
      )}
      {webSearchControlsRes.success && (
        <WebSearchControlPanel
          initial={webSearchControlsRes.data}
          policy={webSearchPolicyRes.success ? webSearchPolicyRes.data : null}
          policyError={!webSearchPolicyRes.success ? webSearchPolicyRes.error : null}
          canEdit={canEdit}
        />
      )}
      {webFetchControlsRes.success && (
        <WebFetchControlPanel initial={webFetchControlsRes.data} canEdit={canEdit} />
      )}
      {modelPolicyRes.success && <ModelPolicyPanel initial={modelPolicyRes.data} canEdit={canEdit} />}
      {gatewayStatsRes.success && (
        <ModelGatewayPanel
          stats={gatewayStatsRes.data}
          routingPolicies={routingPoliciesRes.success ? routingPoliciesRes.data : []}
          budgets={budgetsRes.success ? budgetsRes.data : []}
          canEdit={canEdit}
        />
      )}
    </div>
  )
}
