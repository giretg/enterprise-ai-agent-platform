import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { Card } from '@/components/ui/shell'
import {
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
} from '@/lib/control-plane-entry'

/**
 * GET /me "várj a jóváhagyásra" nézet (Feature-spec IAM-RBAC §7/B, §6).
 * `pending` + `role = NULL` fiók csak ezt látja — admin-jóváhagyásig semmilyen
 * védett végponthoz nem fér (N-IAM-3).
 *
 * Aktív szerep NEM elég a visszairányításhoz: tenant-tagság nélkül a gyökér
 * újra ide küldene (loop → üres képernyő). Csak tenant- vagy platform-kontextus
 * léphet tovább.
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

  const hasRole = Boolean(user?.status === 'active' && user.role)
  const t = await getTranslations('ControlPlane.pending')
  const email = user?.email ?? ''

  return (
    <div className="mx-auto max-w-xl">
      <Card title={hasRole ? t('titleNoMembership') : t('titleAwaiting')}>
        <p className="text-sm text-ink-soft">
          {hasRole
            ? t('bodyNoMembership', { email })
            : user
              ? t('bodyAwaitingKnown', { email })
              : t('bodyAwaitingUnknown')}
        </p>
        {user?.status === 'suspended' && (
          <p className="mt-3 text-sm text-coral-deep">{t('suspended')}</p>
        )}
        <p className="mt-4 text-xs text-ink-faint">{t('hint')}</p>
      </Card>
    </div>
  )
}
