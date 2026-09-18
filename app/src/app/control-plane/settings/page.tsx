import { requireTenantRole } from '@/auth/tenant-context'
import { getTenantLanguage } from '@/app/actions/tenant-language'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { TenantLanguagePanel } from './tenant-language-panel'

export default async function TenantSettingsPage() {
  await requireTenantRole('admin')
  const language = await getTenantLanguage()

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Beállítások</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Tenant beállítások</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A tenant saját magatartása. A Google OAuth kliens a Platform · Beállítások alatt él, a
          menü-láthatóság a Menü-hozzáférés oldalon.
        </p>
      </div>
      <SettingsSectionShell
        ariaLabel="Tenant beállítások"
        sections={[
          {
            id: 'language',
            label: 'Nyelv',
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
