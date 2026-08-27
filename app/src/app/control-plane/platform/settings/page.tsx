import { getAuthContext } from '@/auth/context'
import {
  getDatabaseMode,
  getDispatcherControls,
  getModelCallsSummary,
  getModelPolicy,
  listModelRoutingPolicies,
} from '@/app/actions/platform'
import { getMonitorControls } from '@/app/actions/monitor'
import {
  getWebFetchControls,
  getWebSearchControls,
  getPlatformWebSearchPolicy,
} from '@/app/actions/web-search'
import { getSystemAgentsPageData } from '@/app/actions/system-agents'
import { getPlatformGoogleOAuth, getPlatformGoogleDriveOAuthConfig } from '@/app/actions/connector-grants'
import { readDispatcherRuntime } from '@/lib/dispatcher-runtime'
import { enabledModelProviders } from '@/lib/model-policy'
import { PLAYBOOK_AUTHOR_AGENT_NAME, PROVISIONING_ASSISTANT_AGENT_NAME } from '@/lib/platform-agent-registry'
import type { ModelType } from '@/lib/model-providers'
import { DatabaseControlPanel } from '@/app/control-plane/system/database-control-panel'
import { AutomationSettingsLinkPanel } from '@/app/control-plane/system/automation-settings-link-panel'
import { ModelGatewayPanel } from '@/app/control-plane/system/model-gateway-panel'
import { ModelPolicyPanel } from '@/app/control-plane/system/model-policy-panel'
import { WebSearchControlPanel } from '@/app/control-plane/system/web-search-control-panel'
import { WebFetchControlPanel } from '@/app/control-plane/system/web-fetch-control-panel'
import { GoogleOAuthControlPanel } from '@/app/control-plane/system/google-oauth-control-panel'
import { GoogleDriveOAuthControlPanel } from '@/app/control-plane/system/google-drive-oauth-control-panel'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { UpdateModelConfigForm } from '@/components/agents/update-model-config-form'
import { Card } from '@/components/ui/shell'

function purposeFor(name: string): string {
  if (name === PLAYBOOK_AUTHOR_AGENT_NAME) {
    return 'Természetes nyelvű folyamatleírásból validálható Playbook-draftot készít; nem publikál és nem aktivál.'
  }
  if (name === PROVISIONING_ASSISTANT_AGENT_NAME) {
    return 'Tenant-provisioninghez és skill-előkészítéshez készít ellenőrizhető javaslatot; nem hajt végre önálló aktiválást.'
  }
  return 'Tenant nélküli, platform-szintű agent. Modellválasztása minden tenant futására hatással lehet.'
}

/**
 * Platform-globális policy-k (Tenant-Management §9.2, §13/4): DB-környezet, model
 * policy/gateway, web-fetch/web-search. Az automatizmus-vezérlés (dispatcher, biztonsági
 * háló, monitor) a Rendszer → Üzemeltetés oldalon van.
 */
export default async function PlatformSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>
}) {
  const query = await searchParams
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
    systemAgentsRes,
    googleOauthRes,
    googleDriveOauthRes,
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
    getSystemAgentsPageData(),
    getPlatformGoogleOAuth(),
    getPlatformGoogleDriveOAuthConfig(),
  ])
  const isPlatform = Boolean(
    ctx && (ctx.platformRoles.includes('superadmin') || ctx.platformRoles.includes('platform_operator')),
  )
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))
  const enabledProviders = modelPolicyRes.success
    ? enabledModelProviders(modelPolicyRes.data)
    : undefined
  const systemAgentProviders = systemAgentsRes.success
    ? enabledModelProviders(systemAgentsRes.data.modelPolicy)
    : undefined
  const errorBox = (message: string) => (
    <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
      {message}
    </div>
  )

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
          Válassz témát a bal oldalon — egyszerre csak az adott platform-szintű beállítás jelenik meg.
        </p>
      </header>

      <SettingsSectionShell
        ariaLabel="Platform beállítási témák"
        initialId={query.section}
        sections={[
          {
            id: 'adatbazis',
            label: 'Adatbázis',
            description: 'Éles / teszt adatbázis környezet (Neon).',
            content: dbModeRes.success
              ? <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />
              : errorBox(dbModeRes.error),
          },
          {
            id: 'automatizmus',
            label: 'Automatizmus',
            description: 'Dispatcher, biztonsági háló és monitor vezérlői.',
            content:
              controlsRes.success && monitorControlsRes.success ? (
                <AutomationSettingsLinkPanel
                  dispatcher={controlsRes.data}
                  runtime={readDispatcherRuntime()}
                  monitor={monitorControlsRes.data}
                />
              ) : (
                <div className="space-y-3">
                  {!controlsRes.success ? errorBox(controlsRes.error) : null}
                  {!monitorControlsRes.success ? errorBox(monitorControlsRes.error) : null}
                </div>
              ),
          },
          {
            id: 'google-oauth',
            label: 'Google OAuth (Gmail)',
            description: 'Az Enterprise AI Agent Gmail OAuth clientje minden tenant számára.',
            content: googleOauthRes.success
              ? <GoogleOAuthControlPanel initial={googleOauthRes.data} canEdit={canEdit} />
              : errorBox(googleOauthRes.error),
          },
          {
            id: 'google-drive-oauth',
            label: 'Google Drive OAuth',
            description: 'Külön OAuth client a Google Drive integrációhoz (scope-izoláció a Gmailtől).',
            content: googleDriveOauthRes.success
              ? <GoogleDriveOAuthControlPanel initial={googleDriveOauthRes.data} canEdit={canEdit} />
              : errorBox(googleDriveOauthRes.error),
          },
          {
            id: 'web-search',
            label: 'Web Search',
            description: 'Platform-szintű webkeresési policy és kapcsolók.',
            content: webSearchControlsRes.success ? (
              <WebSearchControlPanel
                initial={webSearchControlsRes.data}
                platformPolicy={webSearchPolicyRes.success ? webSearchPolicyRes.data : null}
                platformError={!webSearchPolicyRes.success ? webSearchPolicyRes.error : null}
                canEdit={canEdit}
              />
            ) : errorBox(webSearchControlsRes.error),
          },
          {
            id: 'web-fetch',
            label: 'Web Fetch',
            description: 'Külső oldalak lekérésének platform-szintű védelme.',
            content: webFetchControlsRes.success
              ? <WebFetchControlPanel initial={webFetchControlsRes.data} canEdit={canEdit} />
              : errorBox(webFetchControlsRes.error),
          },
          {
            id: 'modell-engedelyezes',
            label: 'Modell engedélyezés',
            description: 'Az agentekhez választható provider- és modellpárok.',
            content: modelPolicyRes.success
              ? <ModelPolicyPanel initial={modelPolicyRes.data} canEdit={canEdit} />
              : errorBox(modelPolicyRes.error),
          },
          {
            id: 'model-gateway',
            label: 'Model Gateway',
            description: 'Hívásstatisztika, routing és költségszabályok.',
            content: gatewayStatsRes.success
              ? (
                <ModelGatewayPanel
                  stats={gatewayStatsRes.data}
                  routingPolicies={routingPoliciesRes.success ? routingPoliciesRes.data : []}
                  canEdit={canEdit}
                  providers={enabledProviders}
                />
              )
              : errorBox(gatewayStatsRes.error),
          },
          {
            id: 'rendszer-agentek',
            label: 'Rendszer agentek',
            description: 'A beépített háttéragentek célja és gondolkodási motorja.',
            content: !systemAgentsRes.success ? (
              errorBox(systemAgentsRes.error)
            ) : systemAgentsRes.data.agents.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-soft">Nincs seedelt rendszeragent.</p>
              </Card>
            ) : (
              <div className="space-y-5">
                {!canEdit ? (
                  <div className="rounded-lg border border-honey/35 bg-honey/10 p-4 text-sm text-ink-soft">
                    Megtekintési jogosultságod van. Modellbeállítást csak superadmin módosíthat.
                  </div>
                ) : null}
                {systemAgentsRes.data.agents.map((agent) => {
                  const config = agent.modelConfig as Record<string, unknown>
                  const modelType = config.modelType
                  return (
                    <Card key={agent.id} className="space-y-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="font-display text-xl font-semibold text-ink">{agent.name}</h2>
                          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-soft">
                            {purposeFor(agent.name)}
                          </p>
                        </div>
                        <span className="rounded-full border border-line bg-night/40 px-3 py-1 text-xs text-ink-soft">
                          Agent v{agent.currentVersion}
                        </span>
                      </div>
                      {canEdit ? (
                        <UpdateModelConfigForm
                          embedded
                          agentId={agent.id}
                          providers={systemAgentProviders}
                          scope="system"
                          mode="model-only"
                          current={{
                            provider: String(config.provider ?? 'chatgpt-oauth'),
                            model: String(config.model ?? ''),
                            modelType:
                              modelType === 'luna' || modelType === 'terra' || modelType === 'sol'
                                ? (modelType as ModelType)
                                : undefined,
                            temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
                            maxTokens: typeof config.maxTokens === 'number' ? config.maxTokens : undefined,
                            fallbackModels: Array.isArray(config.fallbackModels)
                              ? (config.fallbackModels as Array<{ provider: string; model: string }>).filter(
                                  (row) => row && typeof row.provider === 'string' && typeof row.model === 'string',
                                )
                              : [],
                          }}
                        />
                      ) : (
                        <div>
                          <h3 className="text-sm font-medium text-ink">Gondolkodási motor beállítása</h3>
                          <p className="mt-1 text-sm text-ink-soft">
                            {String(config.provider ?? 'chatgpt-oauth')} / {String(config.model ?? 'nincs beállítva')}
                          </p>
                        </div>
                      )}
                    </Card>
                  )
                })}
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}
