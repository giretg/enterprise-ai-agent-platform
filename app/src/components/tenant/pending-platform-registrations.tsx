'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { approvePlatformRegistration } from '@/app/actions/tenant'
import { formatDateTime } from '@/i18n/format'
import { Badge, Card } from '@/components/ui/shell'

type Registration = { id: string; email: string; name: string; createdAt: string }
type TenantOption = { id: string; displayName: string }
const roles = ['admin', 'approver', 'operator', 'viewer'] as const

export function PendingPlatformRegistrations({
  registrations,
  tenants,
  canManage,
  loadError,
}: {
  registrations: Registration[]
  tenants: TenantOption[]
  canManage: boolean
  loadError: string | null
}) {
  const t = useTranslations('PlatformIam')
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [tenantByUser, setTenantByUser] = useState<Record<string, string>>({})
  const [roleByUser, setRoleByUser] = useState<Record<string, (typeof roles)[number]>>({})
  const [notice, setNotice] = useState<{ userId: string; message: string; error: boolean } | null>(null)

  const assign = (userId: string) => {
    const tenantId = tenantByUser[userId] || tenants[0]?.id
    if (!tenantId) return
    setNotice(null)
    startTransition(async () => {
      const result = await approvePlatformRegistration({
        userId,
        tenantId,
        role: roleByUser[userId] ?? 'viewer',
      })
      if (result.success) {
        setNotice({ userId, message: t('registrationAssigned'), error: false })
        router.refresh()
      } else {
        setNotice({ userId, message: result.error, error: true })
      }
    })
  }

  return (
    <Card title={t('registrationsTitle', { count: registrations.length })}>
      <div className="mb-5 flex flex-wrap items-start gap-3 rounded-xl border border-coral/15 bg-coral/5 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-coral shadow-sm" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8v6m3-3h-6" />
          </svg>
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">{t('registrationsIntroTitle')}</p>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-soft">{t('registrationsIntro')}</p>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-coral/25 bg-coral/5 p-3 text-sm text-coral-deep">{loadError}</div>
      ) : registrations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-card-2/60 px-5 py-8 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-sage/10 text-sage" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
          </span>
          <p className="mt-3 text-sm font-semibold text-ink">{t('registrationsEmptyTitle')}</p>
          <p className="mt-1 text-sm text-ink-soft">{t('registrationsEmpty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {registrations.map((registration) => {
            const selectedTenantId = tenantByUser[registration.id] || tenants[0]?.id || ''
            return (
              <article key={registration.id} className="rounded-xl border border-line bg-card p-4 transition-shadow hover:shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-night-2 text-sm font-bold text-ink-soft">
                    {registration.name.trim().slice(0, 1).toLocaleUpperCase(locale)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-ink">{registration.name}</h3>
                      <Badge tone="warning">{t('registrationPending')}</Badge>
                    </div>
                    <a href={`mailto:${registration.email}`} className="mt-0.5 block w-fit text-sm text-ink-soft underline decoration-line underline-offset-4 hover:text-coral-deep">{registration.email}</a>
                    <p className="mt-1 text-xs text-ink-faint">{t('registrationDate', { date: formatDateTime(registration.createdAt, locale) })}</p>
                  </div>
                </div>

                {canManage ? (
                  <div className="mt-4 grid gap-3 border-t border-line/70 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(145px,0.55fr)_auto] sm:items-end">
                    <label className="text-xs font-semibold text-ink-soft">
                      <span className="mb-1.5 block">{t('registrationTenant')}</span>
                      <select
                        aria-label={`${t('registrationTenant')} — ${registration.email}`}
                        value={selectedTenantId}
                        onChange={(event) => setTenantByUser((current) => ({ ...current, [registration.id]: event.target.value }))}
                        className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-medium text-ink outline-none transition focus:border-coral/60"
                        disabled={tenants.length === 0 || pending}
                      >
                        {tenants.length === 0 && <option value="">{t('registrationNoTenants')}</option>}
                        {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.displayName}</option>)}
                      </select>
                    </label>
                    <label className="text-xs font-semibold text-ink-soft">
                      <span className="mb-1.5 block">{t('role')}</span>
                      <select
                        aria-label={`${t('role')} — ${registration.email}`}
                        value={roleByUser[registration.id] ?? 'viewer'}
                        onChange={(event) => setRoleByUser((current) => ({ ...current, [registration.id]: event.target.value as (typeof roles)[number] }))}
                        className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-medium text-ink outline-none transition focus:border-coral/60"
                        disabled={pending}
                      >
                        {roles.map((role) => <option key={role} value={role}>{t(`roleLabel_${role}`)}</option>)}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => assign(registration.id)}
                      disabled={pending || !selectedTenantId}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-coral disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pending ? t('registrationAssignPending') : t('registrationAssign')}
                      {!pending && <span aria-hidden>→</span>}
                    </button>
                  </div>
                ) : (
                  <p className="mt-4 border-t border-line/70 pt-3 text-xs text-ink-faint">{t('registrationSuperadminOnly')}</p>
                )}

                {notice?.userId === registration.id && (
                  <p role="status" className={`mt-3 text-sm ${notice.error ? 'text-rose' : 'text-sage'}`}>{notice.message}</p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </Card>
  )
}
