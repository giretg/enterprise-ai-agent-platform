import { getAuthContext } from '@/auth/context'
import Link from 'next/link'
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
  getPlatformWebSearchPolicy,
} from '@/app/actions/web-search'
import { readDispatcherRuntime } from '@/lib/dispatcher-runtime'
import { enabledModelProviders } from '@/lib/model-policy'
import { DatabaseControlPanel } from '@/app/control-plane/system/database-control-panel'
import { AutomationSettingsLinkPanel } from '@/app/control-plane/system/automation-settings-link-panel'
import { ModelGatewayPanel } from '@/app/control-plane/system/model-gateway-panel'
import { ModelPolicyPanel } from '@/app/control-plane/system/model-policy-panel'
import { WebSearchControlPanel } from '@/app/control-plane/system/web-search-control-panel'
import { WebFetchControlPanel } from '@/app/control-plane/system/web-fetch-control-panel'

/**
 * Platform-globális policy-k (Tenant-Management §9.2, §13/4): DB-környezet, model
 * policy/gateway, web-fetch/web-search. Az automatizmus-vezérlés (dispatcher, biztonsági
 * háló, monitor) a Rendszer → Üzemeltetés oldalon van.
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
    getPlatformWebSearchPolicy(),
    getWebFetchControls(),
    getModelCallsSummary(),
    listModelRoutingPolicies(),
    listModelBudgets(),
  ])
  const isPlatform = Boolean(
    ctx && (ctx.platformRoles.includes('superadmin') || ctx.platformRoles.includes('platform_operator')),
  )
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))
  const enabledProviders = modelPolicyRes.success
    ? enabledModelProviders(modelPolicyRes.data)
    : undefined

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
          Platform-globális policy-k: adatbázis-környezet, model policy / gateway / routing / budget,
          valamint a web-egress (web-fetch / web-search) kapcsolók. Az agent-indítás, a biztonsági háló
          és a monitor-söprés vezérlése a{' '}
          <Link href="/control-plane/system" className="text-accent hover:underline">
            Rendszer → Üzemeltetés
          </Link>{' '}
          oldalon van — ott látszik a futásidő-állapot és a költségkontroll is.
        </p>
      </header>

      {dbModeRes.success && <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />}
      {controlsRes.success && monitorControlsRes.success && (
        <AutomationSettingsLinkPanel
          dispatcher={controlsRes.data}
          runtime={readDispatcherRuntime()}
          monitor={monitorControlsRes.data}
        />
      )}
      {webSearchControlsRes.success && (
        <WebSearchControlPanel
          initial={webSearchControlsRes.data}
          platformPolicy={webSearchPolicyRes.success ? webSearchPolicyRes.data : null}
          platformError={!webSearchPolicyRes.success ? webSearchPolicyRes.error : null}
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
          providers={enabledProviders}
        />
      )}
    </div>
  )
}
