import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { Card } from '@/components/ui/shell'
import {
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  ONBOARDING_PATH,
} from '@/lib/control-plane-entry'

/**
 * Várakozó / felfüggesztett nézet. #830 D6 óta a meghívó nélküli új fiók NEM ide
 * jön, hanem az onboardingra (saját cég vagy meghívó elfogadása). Ez a képernyő
 * a felfüggesztett fióknak marad, és annak az edge-esetnek, amikor a Clerk-session
 * mögött nincs belső fiók (pl. nem igazolt e-mail, nem engedett domain).
 *
 * Aktív szerep NEM elég a visszairányításhoz: csak tenant- vagy platform-kontextus
 * léphet tovább, különben a gyökér újra ide küldene (loop → üres képernyő).
 */
export default async function PendingApprovalPage() {
  const ctx = await getAuthContext()
  const user = ctx?.user ?? null

  if (ctx?.kind === 'tenant') {
    redirect(DEFAULT_AGENT_WORKSPACE_FALLBACK)
  }
  if (ctx?.kind === 'platform') {
    redirect(CONTROL_PLANE_PLATFORM_HOME)
  }
  if (user && user.status !== 'suspended') {
    redirect(ONBOARDING_PATH)
  }

  const t = await getTranslations('ControlPlane.pending')
  const suspended = user?.status === 'suspended'

  return (
    <div className="mx-auto max-w-xl">
      <Card title={suspended ? t('titleSuspended') : t('titleNoAccount')}>
        <p className="text-sm text-ink-soft">
          {suspended ? t('bodySuspended', { email: user?.email ?? '' }) : t('bodyNoAccount')}
        </p>
        <p className="mt-4 text-xs text-ink-faint">{t('hint')}</p>
      </Card>
    </div>
  )
}
