import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { getGeminiKeyStatus, getOpenRouterKeyStatus, getTenantModelPolicy } from '@/app/actions/model-config'
import { ModelPolicyPanel } from '@/app/control-plane/system/model-policy-panel'
import { getTenantLanguage } from '@/app/actions/tenant-language'
import { getTenantAgentSettings } from '@/app/actions/tenant-agent-settings'
import { getTenantMcpIntro } from '@/app/actions/tenant-mcp-intro'
import { getMiniAppSettingsAction } from '@/app/actions/mini-apps'
import { MiniAppSettingsPanel } from './mini-app-settings-panel'
import { getWarehouseAgentAccessAction } from '@/app/actions/warehouse'
import { WarehouseAgentAccessPanel, WarehouseStorageCard } from '@/components/warehouse/warehouse-access-panels'
import Link from 'next/link'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { GeminiKeyPanel } from './gemini-key-panel'
import { OpenRouterKeyPanel } from './openrouter-key-panel'
import { TenantAgentSettingsPanel } from './tenant-agent-settings-panel'
import { TenantLanguagePanel } from './tenant-language-panel'
import { TenantMcpIntroPanel } from './tenant-mcp-intro-panel'
import { getPlatformChatSettingsAction } from '@/app/actions/platform-chat'
import { PlatformChatSettingsPanel } from './platform-chat-settings-panel'

export default async function TenantSettingsPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  await requireTenantRole('admin')
  const { section } = await searchParams
  const [language, mcpIntro, modelPolicy, openRouterKey, geminiKey, agentSettings, miniAppSettings, warehouseAccess, platformChat] = await Promise.all([
    getTenantLanguage(),
    getTenantMcpIntro(),
    getTenantModelPolicy(),
    getOpenRouterKeyStatus(),
    getGeminiKeyStatus(),
    getTenantAgentSettings(),
    getMiniAppSettingsAction(),
    getWarehouseAgentAccessAction(),
    getPlatformChatSettingsAction(),
  ])
  const t = await getTranslations('ControlPlane.settings')

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <SettingsSectionShell
        ariaLabel={t('aria')}
        initialId={section}
        sections={[
          {
            id: 'mcp-intro',
            label: t('mcpIntro'),
            content: mcpIntro.success ? (
              <TenantMcpIntroPanel initialIntro={mcpIntro.data.mcpIntro} canEdit />
            ) : (
              <p className="text-sm text-coral-deep">{mcpIntro.error}</p>
            ),
          },
          {
            id: 'models',
            label: t('models'),
            content: modelPolicy.success ? (
              <ModelPolicyPanel initial={modelPolicy.data} canEdit />
            ) : (
              <p className="text-sm text-coral-deep">{t('modelsLoadFailed')}</p>
            ),
          },
          {
            id: 'openrouter',
            label: t('companyKeys'),
            content: (
              <div className="space-y-4">
                {openRouterKey.success ? (
                  <OpenRouterKeyPanel configured={openRouterKey.data.configured} canEdit />
                ) : (
                  <p className="text-sm text-coral-deep">{t('openrouterLoadFailed')}</p>
                )}
                {geminiKey.success ? (
                  <GeminiKeyPanel configured={geminiKey.data.configured} canEdit />
                ) : (
                  <p className="text-sm text-coral-deep">{t('geminiLoadFailed')}</p>
                )}
              </div>
            ),
          },
          {
            id: 'platform-chat',
            label: 'Beszélgetés a platformon',
            content: platformChat.success ? (
              <PlatformChatSettingsPanel initial={platformChat.data} canEdit />
            ) : (
              <p className="text-sm text-coral-deep">{platformChat.error}</p>
            ),
          },
          {
            id: 'agents',
            label: t('agents'),
            content: agentSettings.success ? (
              <TenantAgentSettingsPanel
                initialCeiling={agentSettings.data.autonomyCeiling}
                initialDailyLimit={agentSettings.data.hireDraftDailyLimit}
                canEdit
              />
            ) : (
              <p className="text-sm text-coral-deep">{agentSettings.error}</p>
            ),
          },
          {
            id: 'mini-apps',
            label: t('miniApps'),
            content: miniAppSettings.success ? (
              <MiniAppSettingsPanel initial={miniAppSettings.data} canEdit />
            ) : (
              <p className="text-sm text-coral-deep">{miniAppSettings.error}</p>
            ),
          },
          {
            id: 'warehouse',
            label: t('warehouse'),
            content: warehouseAccess.success ? (
              <div className="space-y-4">
                <WarehouseAgentAccessPanel data={warehouseAccess.data} />
                <WarehouseStorageCard storage={warehouseAccess.data.storage} />
                <p className="text-sm">
                  <Link className="text-coral-deep underline" href="/control-plane/warehouse">
                    Adattárház megnyitása: bekapcsolás, Excel-feltöltés, jóváhagyások →
                  </Link>
                </p>
              </div>
            ) : (
              <p className="text-sm text-coral-deep">{warehouseAccess.error}</p>
            ),
          },
          {
            id: 'language',
            label: t('language'),
            content: language.success ? (
              <TenantLanguagePanel initialLanguage={language.data.language} canEdit />
            ) : (
              <p className="text-sm text-coral-deep">{language.error}</p>
            ),
          },
        ]}
      />
    </div>
  )
}
