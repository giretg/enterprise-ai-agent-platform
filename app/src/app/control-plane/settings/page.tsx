import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { getTenantLanguage } from '@/app/actions/tenant-language'
import { getTenantMcpIntro } from '@/app/actions/tenant-mcp-intro'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { TenantLanguagePanel } from './tenant-language-panel'
import { TenantMcpIntroPanel } from './tenant-mcp-intro-panel'

export default async function TenantSettingsPage() {
  await requireTenantRole('admin')
  const [language, mcpIntro] = await Promise.all([getTenantLanguage(), getTenantMcpIntro()])
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
