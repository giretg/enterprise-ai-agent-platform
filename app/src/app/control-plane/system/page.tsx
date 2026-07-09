import { getAuthContext } from '@/auth/context'
import {
  getDatabaseMode,
  getDispatcherControls,
  getMemoryObservabilityDashboard,
  getModelCallsSummary,
  getModelPolicy,
  getTicketTypeConfigs,
  getWorkerProcessesStatus,
  listModelBudgets,
  listModelRoutingPolicies,
} from '@/app/actions/platform'
import { getMonitorControls } from '@/app/actions/monitor'
import {
  getWebFetchControls,
  getWebSearchControls,
  getWebSearchPolicy,
} from '@/app/actions/web-search'
import { DatabaseControlPanel } from './database-control-panel'
import { DispatcherControlPanel } from './dispatcher-control-panel'
import { WorkerProcessesPanel } from './worker-processes-panel'
import { ModelGatewayPanel } from './model-gateway-panel'
import { ModelPolicyPanel } from './model-policy-panel'
import { TicketTypeConfigPanel } from './ticket-type-config-panel'
import { MonitorControlPanel } from './monitor-control-panel'
import { WebSearchControlPanel } from './web-search-control-panel'
import { WebFetchControlPanel } from './web-fetch-control-panel'
import { MemoryObservabilityPanel } from './memory-observability-panel'

export default async function SystemPage() {
  const [
    ctx,
    controlsRes,
    workerProcessesRes,
    dbModeRes,
    ticketTypesRes,
    modelPolicyRes,
    monitorControlsRes,
    webSearchControlsRes,
    webSearchPolicyRes,
    webFetchControlsRes,
    gatewayStatsRes,
    routingPoliciesRes,
    budgetsRes,
    memoryObservabilityRes,
  ] = await Promise.all([
    getAuthContext(),
    getDispatcherControls(),
    getWorkerProcessesStatus(),
    getDatabaseMode(),
    getTicketTypeConfigs(),
    getModelPolicy(),
    getMonitorControls(),
    getWebSearchControls(),
    getWebSearchPolicy(),
    getWebFetchControls(),
    getModelCallsSummary(),
    listModelRoutingPolicies(),
    listModelBudgets(),
    getMemoryObservabilityDashboard(),
  ])
  // §9.2/§13/4: a platform-globális vezérlőket csak platform-szerep szerkesztheti;
  // a tenant-admin itt read-only nézetet kap (a WRITE-actionök platform-guard alatt).
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Rendszer</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Üzemeltetés</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A háttérben futó automatizmusok és az adatbázis-környezet vezérlése. A dispatcher
          folyamatosan figyeli a ticketeket — itt állítható le, szabályozható, vagy teszt adatbázisra
          váltható.
        </p>
      </div>

      {!dbModeRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {dbModeRes.error}
        </div>
      ) : (
        <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />
      )}

      {!controlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {controlsRes.error}
        </div>
      ) : (
        <DispatcherControlPanel initial={controlsRes.data} canEdit={canEdit} />
      )}

      {!workerProcessesRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {workerProcessesRes.error}
        </div>
      ) : (
        <WorkerProcessesPanel initial={workerProcessesRes.data} canEdit={canEdit} />
      )}

      {!monitorControlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {monitorControlsRes.error}
        </div>
      ) : (
        <MonitorControlPanel initial={monitorControlsRes.data} canEdit={canEdit} />
      )}

      {!webSearchControlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {webSearchControlsRes.error}
        </div>
      ) : (
        <WebSearchControlPanel
          initial={webSearchControlsRes.data}
          policy={webSearchPolicyRes.success ? webSearchPolicyRes.data : null}
          policyError={!webSearchPolicyRes.success ? webSearchPolicyRes.error : null}
          canEdit={canEdit}
        />
      )}

      {!webFetchControlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {webFetchControlsRes.error}
        </div>
      ) : (
        <WebFetchControlPanel initial={webFetchControlsRes.data} canEdit={canEdit} />
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
