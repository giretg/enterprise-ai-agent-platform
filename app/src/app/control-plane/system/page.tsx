import { getAuthContext } from '@/auth/context'
import {
  getDailyBudgetOverview,
  getDatabaseMode,
  getDispatcherControls,
  getMemoryObservabilityDashboard,
  getContractObservabilityDashboard,
  getModelCallsSummary,
  getModelPolicy,
  getTicketTypeConfigs,
  getWorkerProcessesStatus,
  getAutomationIdleSnapshot,
  listModelBudgets,
  listModelRoutingPolicies,
} from '@/app/actions/platform'
import { getMonitorControls } from '@/app/actions/monitor'
import { getChannelOpsMetrics } from '@/app/actions/channel-ops'
import { getTelegramChannelSetup } from '@/app/actions/channel'
import {
  getTenantWebSearchControls,
  getWebSearchPolicy,
} from '@/app/actions/web-search'
import { getTenantThinkingTraceControls } from '@/app/actions/chat-thinking-trace'
import { getTenantLanguage } from '@/app/actions/tenant-language'
import { readDispatcherRuntime } from '@/lib/dispatcher-runtime'
import { enabledModelProviders } from '@/lib/model-policy'
import { DatabaseControlPanel } from './database-control-panel'
import { AutomationControlSection } from './automation-control-section'
import { DailyBudgetPanel } from './daily-budget-panel'
import {
  FallbackChainPanel,
  ModelGatewayObservabilityPanel,
  ModelPricingPanel,
  ModelRoutingPanel,
} from './model-gateway-panel'
import { ModelPolicyPanel } from './model-policy-panel'
import { TicketTypeConfigPanel } from './ticket-type-config-panel'
import { TenantWebSearchPolicyPanel } from './tenant-web-search-policy-panel'
import { TenantThinkingTracePanel } from './tenant-thinking-trace-panel'
import { TenantLanguagePanel } from './tenant-language-panel'
import { MemoryObservabilityPanel } from './memory-observability-panel'
import { ContractObservabilityPanel } from './contract-observability-panel'
import { ChannelOpsPanel } from './channel-ops-panel'
import { ChannelBotPanel } from './channel-bot-panel'
import { SettingsSectionShell } from './system-settings-shell'

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
    tenantThinkingTraceControlsRes,
    tenantLanguageRes,
    gatewayStatsRes,
    routingPoliciesRes,
    budgetsRes,
    memoryObservabilityRes,
    contractObservabilityRes,
    dailyBudgetRes,
    channelOpsRes,
    channelSetupRes,
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
    getTenantThinkingTraceControls(),
    getTenantLanguage(),
    getModelCallsSummary(),
    listModelRoutingPolicies(),
    listModelBudgets(),
    getMemoryObservabilityDashboard(),
    getContractObservabilityDashboard(),
    getDailyBudgetOverview(),
    getChannelOpsMetrics({ windowDays: 7 }),
    getTelegramChannelSetup(),
  ])
  // §9.2/§13/4: a platform-globális vezérlőket csak platform-szerep szerkesztheti;
  // a tenant-admin itt read-only nézetet kap (a WRITE-actionök platform-guard alatt).
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))
  const canEditTenantSettings =
    Boolean(ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin') || canEdit
  // A napi model-keret a saját tenant erőforrása → tenant-admin állíthatja (a WRITE-action
  // maga is `requireTenantRole('admin')` alatt van, ez csak a felület elrejtése).
  const canEditTenantBudget = canEditTenantSettings
  const canEditTenantWebSearch = canEditTenantSettings

  const settingsKey = [
    controlsRes.success ? controlsRes.data.updatedAt : '',
    monitorControlsRes.success ? monitorControlsRes.data.updatedAt : '',
    workerProcessesRes.success ? workerProcessesRes.data.lastCycle?.ranAt : '',
    workerProcessesRes.success && workerProcessesRes.data.scheduler.available
      ? workerProcessesRes.data.scheduler.state
      : '',
    idleSnapshotRes.success ? idleSnapshotRes.data?.savedAt : '',
  ].join('|')

  const enabledProviders = modelPolicyRes.success
    ? enabledModelProviders(modelPolicyRes.data)
    : undefined

  const errorBox = (message: string) => (
    <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
      {message}
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Rendszer</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Üzemeltetés</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Itt látod, mi fut a háttérben és mennyibe kerülhet. Válassz témát a bal oldalon — egyszerre
          egy terület jelenik meg.
        </p>
      </div>

      <SettingsSectionShell
        ariaLabel="Rendszer témák"
        sections={[
          {
            id: 'adatbazis',
            label: 'Adatbázis',
            description: 'Éles / teszt adatbázis váltás (Neon).',
            content: !dbModeRes.success
              ? errorBox(dbModeRes.error)
              : <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />,
          },
          {
            id: 'automatizmus',
            label: 'Automatizmus',
            description: 'Dispatcher, háttérfolyamatok, monitor és költségkontroll.',
            content:
              controlsRes.success && workerProcessesRes.success && monitorControlsRes.success ? (
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
                <div className="space-y-3">
                  {!controlsRes.success ? errorBox(controlsRes.error) : null}
                  {!workerProcessesRes.success ? errorBox(workerProcessesRes.error) : null}
                  {!monitorControlsRes.success ? errorBox(monitorControlsRes.error) : null}
                </div>
              ),
          },
          {
            id: 'napi-keret',
            label: 'Model-keretek',
            description: 'Mennyit dolgozhatnak naponta az AI munkatársak — és a kivételek.',
            content: dailyBudgetRes.success
              ? (
                <DailyBudgetPanel
                  overview={dailyBudgetRes.data}
                  canEdit={canEditTenantBudget}
                  rules={budgetsRes.success ? budgetsRes.data : []}
                  canEditRules={canEdit}
                />
              )
              : errorBox(dailyBudgetRes.error),
          },
          {
            id: 'web-search',
            label: 'Web Search',
            description: 'Tenant webkeresési policy.',
            content: !tenantWebSearchControlsRes.success
              ? errorBox(tenantWebSearchControlsRes.error)
              : (
                <TenantWebSearchPolicyPanel
                  initialPolicy={tenantWebSearchPolicyRes.success ? tenantWebSearchPolicyRes.data : null}
                  initialTenantControls={tenantWebSearchControlsRes.data}
                  policyError={!tenantWebSearchPolicyRes.success ? tenantWebSearchPolicyRes.error : null}
                  canEdit={canEditTenantWebSearch}
                />
              ),
          },
          {
            id: 'thinking-trace',
            label: 'Gondolkodási szöveg',
            description: 'Chat thinking-trace megjelenítése a tenantnél.',
            content: tenantThinkingTraceControlsRes.success ? (
              <TenantThinkingTracePanel
                initialEnabled={tenantThinkingTraceControlsRes.data.enabled}
                canEdit={canEditTenantWebSearch}
              />
            ) : (
              errorBox('Nem sikerült betölteni a thinking-trace beállítást.')
            ),
          },
          {
            id: 'nyelv',
            label: 'Tenant nyelv',
            content: tenantLanguageRes.success
              ? (
                <TenantLanguagePanel
                  initialLanguage={tenantLanguageRes.data.language}
                  canEdit={canEditTenantSettings}
                />
              )
              : errorBox(tenantLanguageRes.error),
          },
          {
            id: 'ticket-tipusok',
            label: 'Tickettípusok',
            description: 'Engedélyezett állapotátmenetek típusonként.',
            content: !ticketTypesRes.success
              ? errorBox(ticketTypesRes.error)
              : <TicketTypeConfigPanel initial={ticketTypesRes.data} canEdit={canEdit} />,
          },
          {
            id: 'modell-engedelyezes',
            label: 'Modell engedélyezés',
            description: 'Mely provider/modell párok választhatók agenthez.',
            content: !modelPolicyRes.success
              ? errorBox(modelPolicyRes.error)
              : <ModelPolicyPanel initial={modelPolicyRes.data} canEdit={canEdit} />,
          },
          {
            id: 'model-gateway',
            label: 'Model Gateway',
            description: 'Hívásstatisztika és top ticket felhasználás.',
            content: gatewayStatsRes.success
              ? <ModelGatewayObservabilityPanel stats={gatewayStatsRes.data} />
              : errorBox('Nem sikerült betölteni a Model Gateway statisztikát.'),
          },
          {
            id: 'kiesesvedelem',
            label: 'Kiesésvédelem',
            description: 'Globális tartalék-lánc szolgáltatói hibákra.',
            content: (
              <FallbackChainPanel canEdit={canEdit} providers={enabledProviders} />
            ),
          },
          {
            id: 'modellarazas',
            label: 'Modellárazás',
            description: '€ / 1M token tarifák — beleértve az engedélyezett modelleket.',
            content: <ModelPricingPanel canEdit={canEdit} />,
          },
          {
            id: 'routing',
            label: 'Routing',
            description: 'Scope-alapú provider/modell irányítás.',
            content: (
              <ModelRoutingPanel
                initial={routingPoliciesRes.success ? routingPoliciesRes.data : []}
                canEdit={canEdit}
                providers={enabledProviders}
              />
            ),
          },
          {
            id: 'memoria',
            label: 'Memória',
            description: 'Memória-javaslatok és retrieval megfigyelhetőség.',
            content: memoryObservabilityRes.success
              ? <MemoryObservabilityPanel data={memoryObservabilityRes.data} />
              : errorBox('Nem sikerült betölteni a memória dashboardot.'),
          },
          {
            id: 'strukturalt-kimenet',
            label: 'Strukturált kimenet',
            description: 'Lépés-kimenetek formátum-ellenőrzése és javítása.',
            content: contractObservabilityRes.success
              ? <ContractObservabilityPanel data={contractObservabilityRes.data} />
              : errorBox('Nem sikerült betölteni a strukturált kimenet dashboardot.'),
          },
          // A csatorna platform-szintű erőforrás → a metrika superadmin-only (mint a bot-regisztráció).
          ...(canEdit
            ? [
                {
                  id: 'csatorna',
                  label: 'Csatorna (Telegram)',
                  description:
                    'A bot beüzemelése (bot, webhook, ellenőrzés), majd forgalmi/hibametrikák és megőrzési takarítás.',
                  content: (
                    <div className="space-y-6">
                      {channelSetupRes.success
                        ? <ChannelBotPanel initial={channelSetupRes.data} canEdit={canEdit} />
                        : errorBox(channelSetupRes.error)}
                      {channelOpsRes.success
                        ? <ChannelOpsPanel initial={channelOpsRes.data} canEdit={canEdit} />
                        : errorBox(channelOpsRes.error)}
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  )
}
