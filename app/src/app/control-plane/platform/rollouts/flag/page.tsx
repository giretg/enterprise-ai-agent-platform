import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getRolloutDetailAction } from '@/app/actions/feature-flags'
import { getAuthContext } from '@/auth/context'
import { RolloutDetailPanel } from '@/components/feature-flags/rollout-detail-panel'
import { RolloutStateBadge } from '@/components/feature-flags/rollout-state-badge'
import { formatCalendarDate, formatDateTime } from '@/i18n/format'
import { hasMinimumPlatformRole, isSuperadmin } from '@/lib/tenant-policy'

type HistoryMetadata = {
  from?: string | null
  to?: string | null
  justification?: string
  gained?: unknown[]
  lost?: unknown[]
  changes?: Array<{ id: string; displayName: string | null; from: string | null; to: string | null }>
}

export default async function PlatformRolloutDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string | string[] }>
}) {
  const { key } = await searchParams
  if (typeof key !== 'string') notFound()
  const [res, ctx, t, locale] = await Promise.all([
    getRolloutDetailAction(key),
    getAuthContext(),
    getTranslations('PlatformRollouts'),
    getLocale(),
  ])
  const back = (
    <Link href="/control-plane/platform/rollouts" className="text-sm font-medium text-ink-soft underline-offset-2 hover:underline">
      {t('backToList')}
    </Link>
  )
  if (!res.success) {
    return (
      <div className="space-y-4">
        {back}
        <div className="rounded-xl border border-rose/30 bg-rose/5 p-4 text-sm text-rose">{t('loadError')}</div>
      </div>
    )
  }
  const flag = res.data
  if (!flag) notFound()

  const lang = locale === 'en' ? 'en' : 'hu'
  const modeLabel = (mode: string | null | undefined) =>
    mode === 'off' || mode === 'selected' || mode === 'all' ? t(`mode.${mode}`) : (mode ?? '—')
  const accessLabel = (access: string | null | undefined) =>
    access === 'included' ? t('tenants.accessIncluded') : access === 'excluded' ? t('tenants.accessExcluded') : t('tenants.accessNone')

  return (
    <div className="space-y-6">
      {back}
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{flag.definition.title[lang]}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <RolloutStateBadge mode={flag.mode} includedCount={flag.includedCount} excludedCount={flag.excludedCount} />
          {flag.stoppedAt ? <span>{t('current.stoppedAt', { date: formatDateTime(flag.stoppedAt, locale) })}</span> : null}
          {flag.fullRolloutAt ? <span>{t('current.fullRolloutAt', { date: formatDateTime(flag.fullRolloutAt, locale) })}</span> : null}
        </div>
      </header>

      <section className="grid gap-4 rounded-xl border border-line bg-ink/[0.03] p-4 text-sm md:grid-cols-2">
        <div>
          <h2 className="font-semibold">{t('whatChanges')}</h2>
          <p className="mt-1 text-ink-soft">{flag.definition.whatChanges[lang]}</p>
        </div>
        <div>
          <h2 className="font-semibold">{t('whenOff')}</h2>
          <p className="mt-1 text-ink-soft">{flag.definition.whenOff[lang]}</p>
        </div>
      </section>

      <RolloutDetailPanel
        flagKey={flag.key}
        version={flag.version}
        mode={flag.mode}
        tenants={flag.tenants.map(({ id, displayName, access }) => ({ id, displayName, access }))}
        canOperate={hasMinimumPlatformRole(ctx?.platformRoles ?? [], 'platform_operator')}
        canSetAll={isSuperadmin(ctx?.platformRoles)}
        removeBy={flag.removeBy ? flag.removeBy.toISOString() : null}
        reviewBy={flag.definition.reviewBy}
        deadlineExpired={flag.deadline.expired}
      />

      <section className="atelier-card p-4 sm:p-5">
        <h2 className="mb-3 font-display text-lg font-semibold tracking-tight">{t('history.title')}</h2>
        {flag.history.length === 0 ? (
          <p className="text-sm text-ink-soft">{t('history.empty')}</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {flag.history.map((entry) => {
              const meta = (entry.metadata ?? {}) as HistoryMetadata
              return (
                <li key={entry.id} className="border-b border-line/60 pb-3 last:border-0 last:pb-0">
                  <div className="text-xs text-ink-soft">
                    {formatDateTime(entry.createdAt, locale)} · {(entry.actorId && flag.actorNames[entry.actorId]) || t('history.system')}
                  </div>
                  {entry.action === 'platform.feature_flag.mode_set' ? (
                    <div className="mt-1 font-medium">{t('history.mode', { from: modeLabel(meta.from), to: modeLabel(meta.to) })}</div>
                  ) : null}
                  {entry.action === 'platform.feature_flag.deadline_extended' ? (
                    <div className="mt-1 font-medium">
                      {t('history.deadline', { from: formatCalendarDate(meta.from ?? '', locale), to: formatCalendarDate(meta.to ?? '', locale) })}
                    </div>
                  ) : null}
                  {meta.changes?.map((change) => (
                    <div key={change.id} className="mt-1 font-medium">
                      {t('history.tenant', { name: change.displayName ?? change.id, from: accessLabel(change.from), to: accessLabel(change.to) })}
                    </div>
                  ))}
                  {meta.gained?.length ? <div className="mt-1 text-ink-soft">{t('history.gained', { count: meta.gained.length })}</div> : null}
                  {meta.lost?.length ? <div className="mt-1 text-ink-soft">{t('history.lost', { count: meta.lost.length })}</div> : null}
                  {meta.justification ? <p className="mt-1 text-ink-soft">{meta.justification}</p> : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
