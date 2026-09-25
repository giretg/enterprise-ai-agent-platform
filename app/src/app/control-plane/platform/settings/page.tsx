import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import {
  getPlatformGoogleOAuth,
  getPlatformGoogleDriveOAuthConfig,
  getPlatformGoogleApiOAuth,
  getPlatformGoogleDrivePickerConfig,
} from '@/app/actions/connector-grants'
import { GoogleOAuthControlPanel } from '@/app/control-plane/system/google-oauth-control-panel'
import { GoogleDriveOAuthControlPanel } from '@/app/control-plane/system/google-drive-oauth-control-panel'
import { GoogleApiOAuthControlPanel } from '@/app/control-plane/system/google-api-oauth-control-panel'
import { GoogleDrivePickerControlPanel } from '@/app/control-plane/system/google-drive-picker-control-panel'
import { SettingsSectionShell } from '@/app/control-plane/system/system-settings-shell'
import { hasMinimumPlatformRole } from '@/lib/tenant-policy'

export default async function PlatformSettingsPage() {
  const ctx = await getAuthContext()
  const canEdit = hasMinimumPlatformRole(ctx?.platformRoles ?? [], 'platform_operator')
  const [gmail, drive, googleApi, picker] = await Promise.all([
    getPlatformGoogleOAuth(),
    getPlatformGoogleDriveOAuthConfig(),
    getPlatformGoogleApiOAuth(),
    getPlatformGoogleDrivePickerConfig(),
  ])

  const t = await getTranslations('ControlPlane.platformSettings')
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
            id: 'gmail-oauth',
            label: t('gmail'),
            content: gmail.success ? (
              <GoogleOAuthControlPanel initial={gmail.data} canEdit={canEdit} />
            ) : (
              <p className="text-sm text-coral-deep">{gmail.error}</p>
            ),
          },
          {
            id: 'drive-oauth',
            label: t('drive'),
            content: drive.success ? (
              <GoogleDriveOAuthControlPanel initial={drive.data} canEdit={canEdit} />
            ) : (
              <p className="text-sm text-coral-deep">{drive.error}</p>
            ),
          },
          {
            id: 'google-api-oauth',
            label: t('googleApi'),
            content: googleApi.success ? (
              <GoogleApiOAuthControlPanel initial={googleApi.data} canEdit={canEdit} />
            ) : (
              <p className="text-sm text-coral-deep">{googleApi.error}</p>
            ),
          },
          {
            id: 'drive-picker',
            label: t('picker'),
            content: picker.success ? (
              <GoogleDrivePickerControlPanel initial={picker.data} canEdit={canEdit} />
            ) : (
              <p className="text-sm text-coral-deep">{picker.error}</p>
            ),
          },
        ]}
      />
    </div>
  )
}
