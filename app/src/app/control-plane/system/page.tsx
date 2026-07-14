import { getAuthContext } from '@/auth/context'
import {
  getDailyBudgetOverview,
  getDatabaseMode,
  getDispatcherControls,
  getMemoryObservabilityDashboard,
  getModelCallsSummary,
  getModelPolicy,
  getTicketTypeConfigs,
  getWorkerProcessesStatus,
  getAutomationIdleSnapshot,
  listModelBudgets,
  listModelRoutingPolicies,
} from '@/app/actions/platform'
import { getMonitorControls } from '@/app/actions/monitor'
import {
  getTenantWebSearchControls,
  getWebSearchPolicy,
} from '@/app/actions/web-search'
import { readDispatcherRuntime } from '@/lib/dispatcher-runtime'
import { DatabaseControlPanel } from './database-control-panel'
import { AutomationControlSection } from './automation-control-section'
import { DailyBudgetPanel } from './daily-budget-panel'
import { ModelGatewayPanel } from './model-gateway-panel'
import { ModelPolicyPanel } from './model-policy-panel'
import { TicketTypeConfigPanel } from './ticket-type-config-panel'
import { TenantWebSearchPolicyPanel } from './tenant-web-search-policy-panel'
import { MemoryObservabilityPanel } from './memory-observability-panel'

export default async function SystemPage() {
  const [
    ctx,
    controlsRes,
    workerProcessesRes,
    idleSnapshotRes,
    dbModeRes,
    ticketTypesRes,
    modelPolicyRes,
    monitorControlsRes,
    tenantWebSearchPolicyRes,
    tenantWebSearchControlsRes,
    gatewayStatsRes,
    routingPoliciesRes,
    budgetsRes,
    memoryObservabilityRes,
    dailyBudgetRes,
  ] = await Promise.all([
    getAuthContext(),
    getDispatcherControls(),
    getWorkerProcessesStatus(),
    getAutomationIdleSnapshot(),
    getDatabaseMode(),
    getTicketTypeConfigs(),
    getModelPolicy(),
    getMonitorControls(),
    getWebSearchPolicy(),
    getTenantWebSearchControls(),
    getModelCallsSummary(),
    listModelRoutingPolicies(),
    listModelBudgets(),
    getMemoryObservabilityDashboard(),
    getDailyBudgetOverview(),
  ])
  // §9.2/§13/4: a platform-globális vezérlőket csak platform-szerep szerkesztheti;
  // a tenant-admin itt read-only nézetet kap (a WRITE-actionök platform-guard alatt).
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))
  const canEditTenantWebSearch =
    Boolean(ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin') || canEdit
  // A napi model-keret a saját tenant erőforrása → tenant-admin állíthatja (a WRITE-action
  // maga is `requireTenantRole('admin')` alatt van, ez csak a felület elrejtése).
  const canEditTenantBudget = canEditTenantWebSearch

  const settingsKey = [
    controlsRes.success ? controlsRes.data.updatedAt : '',
    monitorControlsRes.success ? monitorControlsRes.data.updatedAt : '',
    workerProcessesRes.success ? workerProcessesRes.data.lastCycle?.ranAt : '',
    workerProcessesRes.success && workerProcessesRes.data.scheduler.available
      ? workerProcessesRes.data.scheduler.state
      : '',
    idleSnapshotRes.success ? idleSnapshotRes.data?.savedAt : '',
  ].join('|')

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Rendszer</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Üzemeltetés</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Itt látod, mi fut a háttérben és mennyibe kerülhet. A ticketek többsége keletkezéskor azonnal
          indul — a panelek az <em>automatikus</em> folyamatokat szabályozzák: agent-indítás, ütemezett
          karbantartó körök (Neon ébresztés), proaktív monitor-söprés.
        </p>
      </div>

      {!dbModeRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {dbModeRes.error}
        </div>
      ) : (
        <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />
      )}

      {controlsRes.success && workerProcessesRes.success && monitorControlsRes.success ? (
        <AutomationControlSection
          dispatcher={controlsRes.data}
          runtime={readDispatcherRuntime()}
          workerStatus={workerProcessesRes.data}
          monitor={monitorControlsRes.data}
          idleSnapshot={idleSnapshotRes.success ? idleSnapshotRes.data : null}
          canEdit={canEdit}
          settingsKey={settingsKey}
        />
      ) : (
        <>
          {!controlsRes.success ? (
            <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
              {controlsRes.error}
            </div>
          ) : null}
          {!workerProcessesRes.success ? (
            <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
              {workerProcessesRes.error}
            </div>
          ) : null}
          {!monitorControlsRes.success ? (
            <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
              {monitorControlsRes.error}
            </div>
          ) : null}
        </>
      )}

      {dailyBudgetRes.success ? (
        <DailyBudgetPanel overview={dailyBudgetRes.data} canEdit={canEditTenantBudget} />
      ) : (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {dailyBudgetRes.error}
        </div>
      )}

      {!tenantWebSearchControlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {tenantWebSearchControlsRes.error}
        </div>
      ) : (
        <TenantWebSearchPolicyPanel
          initialPolicy={tenantWebSearchPolicyRes.success ? tenantWebSearchPolicyRes.data : null}
          initialTenantControls={tenantWebSearchControlsRes.data}
          policyError={!tenantWebSearchPolicyRes.success ? tenantWebSearchPolicyRes.error : null}
          canEdit={canEditTenantWebSearch}
        />
      )}

      {!ticketTypesRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {ticketTypesRes.error}
        </div>
      ) : (
        <TicketTypeConfigPanel initial={ticketTypesRes.data} canEdit={canEdit} />
      )}

      {!modelPolicyRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {modelPolicyRes.error}
        </div>
      ) : (
        <ModelPolicyPanel initial={modelPolicyRes.data} canEdit={canEdit} />
      )}

      {gatewayStatsRes.success && (
        <ModelGatewayPanel
          stats={gatewayStatsRes.data}
          routingPolicies={routingPoliciesRes.success ? routingPoliciesRes.data : []}
          budgets={budgetsRes.success ? budgetsRes.data : []}
          canEdit={canEdit}
        />
      )}

      {memoryObservabilityRes.success && <MemoryObservabilityPanel data={memoryObservabilityRes.data} />}
    </div>
  )
}
