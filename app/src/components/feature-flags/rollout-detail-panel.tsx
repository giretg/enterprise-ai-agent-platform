'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  applyRolloutChangeAction,
  extendRolloutDeadlineAction,
  previewRolloutChangeAction,
} from '@/app/actions/feature-flags'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge } from '@/components/ui/shell'
import { decideFeatureFlag, type FeatureFlagModeValue, type FeatureFlagTenantAccessValue } from '@/domain/feature-flags/evaluate'
import { formatCalendarDate } from '@/i18n/format'

type TenantRow = { id: string; displayName: string; access: FeatureFlagTenantAccessValue | null }
type TenantRef = { id: string; displayName: string }
type Review = { stop: boolean; mode: FeatureFlagModeValue; tenantAccess: Array<{ tenantId: string; access: FeatureFlagTenantAccessValue | null }>; gains: TenantRef[]; loses: TenantRef[] }
type OutcomeKey =
  | 'saved'
  | 'auditFailed'
  | 'blockedAudit'
  | 'conflict'
  | 'forbidden'
  | 'noChange'
  | 'invalidJustification'
  | 'invalidTenant'
  | 'invalidDate'
  | 'generic'
  | 'extended'
type Notice = { tone: 'success' | 'warning' | 'error'; key: OutcomeKey }

const MODES: FeatureFlagModeValue[] = ['off', 'selected', 'all']

const OUTCOME_KEY: Record<string, OutcomeKey> = {
  conflict: 'conflict',
  forbidden: 'forbidden',
  no_change: 'noChange',
  invalid_justification: 'invalidJustification',
  invalid_tenant: 'invalidTenant',
  invalid_date: 'invalidDate',
  audit_failed: 'blockedAudit',
  unknown_flag: 'generic',
}

const NOTICE_TONE = {
  success: 'border-sage/30 bg-sage/10 text-sage',
  warning: 'border-honey/30 bg-honey/10 text-ink',
  error: 'border-rose/30 bg-rose/5 text-rose',
}

export function RolloutDetailPanel(props: {
  flagKey: string
  version: number
  mode: FeatureFlagModeValue
  tenants: TenantRow[]
  canOperate: boolean
  canSetAll: boolean
  removeBy: string | null
  reviewBy: string
  deadlineExpired: boolean
}) {
  const { flagKey, version, mode, tenants, canOperate, canSetAll, removeBy, reviewBy, deadlineExpired } = props
  const t = useTranslations('PlatformRollouts')
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [draftMode, setDraftMode] = useState(mode)
  const [draftAccess, setDraftAccess] = useState<ReadonlyMap<string, FeatureFlagTenantAccessValue | null>>(new Map())
  const [syncedVersion, setSyncedVersion] = useState(version)
  // Új változat érkezett (saját mentés vagy más módosítása): a piszkozat már nem érvényes, újra át kell nézni.
  if (version !== syncedVersion) {
    setSyncedVersion(version)
    setDraftMode(mode)
    setDraftAccess(new Map())
  }

  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [justification, setJustification] = useState('')
  const [dialogError, setDialogError] = useState<OutcomeKey | null>(null)
  const [newDeadline, setNewDeadline] = useState('')
  const [deadlineReason, setDeadlineReason] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (review) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [review])

  const currentState = useMemo(
    () => ({ mode, tenants: new Map(tenants.flatMap((row) => (row.access ? [[row.id, row.access] as const] : []))) }),
    [mode, tenants],
  )
  const draftState = useMemo(() => {
    const next = new Map(currentState.tenants)
    for (const [id, access] of draftAccess) {
      if (access === null) next.delete(id)
      else next.set(id, access)
    }
    return { mode: draftMode, tenants: next }
  }, [currentState, draftAccess, draftMode])
  const tenantChanges = useMemo(
    () =>
      [...draftAccess.entries()]
        .filter(([id, access]) => (currentState.tenants.get(id) ?? null) !== access)
        .map(([tenantId, access]) => ({ tenantId, access })),
    [currentState, draftAccess],
  )
  const dirty = draftMode !== mode || tenantChanges.length > 0

  const visibleTenants = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale)
    return query ? tenants.filter((row) => row.displayName.toLocaleLowerCase(locale).includes(query)) : tenants
  }, [locale, search, tenants])

  const openReview = (stop: boolean) => {
    const change = stop ? { mode: 'off' as const, tenantAccess: [] } : { mode: draftMode, tenantAccess: tenantChanges }
    setNotice(null)
    startTransition(async () => {
      const res = await previewRolloutChangeAction({ key: flagKey, expectedVersion: version, ...change })
      if (!res.success) return setNotice({ tone: 'error', key: 'generic' })
      if (res.data.status !== 'ok') {
        setNotice({ tone: res.data.status === 'no_change' ? 'warning' : 'error', key: OUTCOME_KEY[res.data.status] ?? 'generic' })
        if (res.data.status === 'conflict') router.refresh()
        return
      }
      setJustification('')
      setDialogError(null)
      setReview({ stop, ...change, gains: res.data.gains, loses: res.data.loses })
    })
  }

  const save = () => {
    if (!review) return
    setDialogError(null)
    startTransition(async () => {
      const res = await applyRolloutChangeAction({
        key: flagKey,
        expectedVersion: version,
        mode: review.mode,
        tenantAccess: review.tenantAccess,
        justification,
      })
      if (!res.success) return setDialogError('generic')
      const { status } = res.data
      if (status === 'invalid_justification') return setDialogError(OUTCOME_KEY[status])
      setReview(null)
      if (status === 'applied') {
        setNotice(res.data.auditFailed ? { tone: 'warning', key: 'auditFailed' } : { tone: 'success', key: 'saved' })
      } else {
        setNotice({ tone: 'error', key: OUTCOME_KEY[status] ?? 'generic' })
      }
      router.refresh()
    })
  }

  const extendDeadline = () => {
    setNotice(null)
    startTransition(async () => {
      const res = await extendRolloutDeadlineAction({ key: flagKey, expectedVersion: version, removeBy: newDeadline, justification: deadlineReason })
      if (!res.success) return setNotice({ tone: 'error', key: 'generic' })
      if (res.data.status === 'extended') {
        setNotice({ tone: 'success', key: 'extended' })
        setNewDeadline('')
        setDeadlineReason('')
      } else {
        setNotice({ tone: 'error', key: OUTCOME_KEY[res.data.status] ?? 'generic' })
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {notice ? (
        <div role="status" className={`rounded-xl border p-3 text-sm ${NOTICE_TONE[notice.tone]}`}>
          {t(`outcome.${notice.key}`)}
        </div>
      ) : null}

      {canOperate && mode !== 'off' ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose/30 bg-rose/5 p-4">
          <p className="max-w-2xl text-sm text-ink-soft">{t('stop.help')}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => openReview(true)}
            className="rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('stop.button')}
          </button>
        </section>
      ) : null}

      <section className="atelier-card p-4 sm:p-5">
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          {t('mode.title')}
          <HelpHint>{t('mode.help')}</HelpHint>
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {MODES.map((option) => {
            const locked = !canOperate || (option === 'all' && mode !== 'all' && !canSetAll)
            return (
              <label
                key={option}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${
                  draftMode === option ? 'border-coral bg-coral/5' : 'border-line'
                } ${locked ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="rollout-mode"
                    value={option}
                    checked={draftMode === option}
                    disabled={locked}
                    onChange={() => setDraftMode(option)}
                  />
                  {t(`mode.${option}`)}
                </span>
                <span className="text-ink-soft">
                  {option === 'all' && mode !== 'all' && !canSetAll ? t('mode.allForbidden') : t(`mode.${option}Help`)}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section className="atelier-card p-4 sm:p-5">
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          {t('tenants.title')}
          <HelpHint>{t('tenants.help')}</HelpHint>
        </h2>
        <label className="mb-3 block text-sm font-medium">
          {t('tenants.search')}
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('tenants.searchPlaceholder')}
            className="mt-1 block w-full max-w-md rounded-lg border border-line bg-transparent px-3 py-2 font-normal"
          />
        </label>
        {visibleTenants.length === 0 ? (
          <p className="text-sm text-ink-soft">{t('tenants.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th className="py-2 pr-4 font-medium">{t('tenants.name')}</th>
                  <th className="py-2 pr-4 font-medium">{t('tenants.access')}</th>
                  <th className="py-2 font-medium">{t('tenants.result')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleTenants.map((row) => {
                  const access = draftState.tenants.get(row.id) ?? null
                  const before = decideFeatureFlag(currentState, row.id).active
                  const after = decideFeatureFlag(draftState, row.id).active
                  return (
                    <tr key={row.id} className="border-b border-line/60 last:border-0">
                      <td className="py-2 pr-4 font-medium">{row.displayName}</td>
                      <td className="py-2 pr-4">
                        <select
                          aria-label={`${t('tenants.access')}: ${row.displayName}`}
                          value={access ?? ''}
                          disabled={!canOperate}
                          onChange={(event) => {
                            const value = event.target.value
                            const nextAccess = value === 'included' || value === 'excluded' ? value : null
                            setDraftAccess((prev) => new Map(prev).set(row.id, nextAccess))
                          }}
                          className="rounded-lg border border-line bg-transparent px-2 py-1"
                        >
                          <option value="">{t('tenants.accessNone')}</option>
                          <option value="included">{t('tenants.accessIncluded')}</option>
                          <option value="excluded">{t('tenants.accessExcluded')}</option>
                        </select>
                      </td>
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <Badge tone={after ? 'success' : 'neutral'}>{after ? t('tenants.active') : t('tenants.inactive')}</Badge>
                          {before !== after ? <span className="text-xs font-semibold text-honey">{t('tenants.changing')}</span> : null}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {canOperate ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() => openReview(false)}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              {t('review.button')}
            </button>
          </div>
        ) : null}
      </section>

      <section className="atelier-card p-4 sm:p-5">
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          {t('deadlineCard.title')}
          <HelpHint>{t('deadlineCard.help')}</HelpHint>
        </h2>
        {!removeBy ? (
          <p className={`text-sm ${deadlineExpired ? 'font-semibold text-rose' : 'text-ink-soft'}`}>
            {t('deadlineCard.noDeadline', { date: formatCalendarDate(`${reviewBy}T00:00:00Z`, locale) })}
          </p>
        ) : (
          <>
            <p className={`text-sm ${deadlineExpired ? 'font-semibold text-rose' : 'text-ink-soft'}`}>
              {t('deadlineCard.current', { date: formatCalendarDate(removeBy, locale) })}
              {deadlineExpired ? ` (${t('deadline.expired')})` : ''}
            </p>
            {canOperate ? (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="text-sm font-medium">
                  {t('deadlineCard.newDate')}
                  <input
                    type="date"
                    value={newDeadline}
                    onChange={(event) => setNewDeadline(event.target.value)}
                    className="mt-1 block rounded-lg border border-line bg-transparent px-3 py-2 font-normal"
                  />
                </label>
                <label className="min-w-[16rem] flex-1 text-sm font-medium">
                  {t('deadlineCard.justification')}
                  <input
                    type="text"
                    value={deadlineReason}
                    maxLength={500}
                    onChange={(event) => setDeadlineReason(event.target.value)}
                    className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 font-normal"
                  />
                </label>
                <button
                  type="button"
                  disabled={!newDeadline || !deadlineReason.trim() || pending}
                  onClick={extendDeadline}
                  className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-ink/5 disabled:opacity-50"
                >
                  {t('deadlineCard.extend')}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <dialog
        ref={dialogRef}
        aria-labelledby="rollout-review-title"
        onClose={() => setReview(null)}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-line bg-paper p-5 text-ink backdrop:bg-ink/40"
      >
        {review ? (
          <div className="space-y-4">
            <h2 id="rollout-review-title" className="font-display text-lg font-semibold tracking-tight">{review.stop ? t('stop.title') : t('review.title')}</h2>
            {review.gains.length === 0 && review.loses.length === 0 ? (
              <p className="text-sm text-ink-soft">{t('review.none')}</p>
            ) : null}
            {review.gains.length > 0 ? (
              <div className="text-sm">
                <p className="font-semibold">{t('review.gains', { count: review.gains.length })}</p>
                <p className="mt-1 max-h-32 overflow-y-auto text-ink-soft">{review.gains.map((row) => row.displayName).join(', ')}</p>
              </div>
            ) : null}
            {review.loses.length > 0 ? (
              <div className="text-sm">
                <p className="font-semibold">{t('review.loses', { count: review.loses.length })}</p>
                <p className="mt-1 max-h-32 overflow-y-auto text-ink-soft">{review.loses.map((row) => row.displayName).join(', ')}</p>
              </div>
            ) : null}
            <label className="block text-sm font-medium">
              {t('review.justification')}
              <textarea
                value={justification}
                rows={2}
                maxLength={500}
                autoFocus
                onChange={(event) => setJustification(event.target.value)}
                placeholder={review.stop ? undefined : t('review.placeholder')}
                className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2 font-normal"
              />
              <span className="mt-1 block text-xs font-normal text-ink-soft">
                {review.stop ? t('stop.hint') : t('review.justificationHelp')}
              </span>
            </label>
            {dialogError ? <p className="text-sm text-rose">{t(`outcome.${dialogError}`)}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReview(null)} className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-ink/5">
                {t('review.cancel')}
              </button>
              <button
                type="button"
                disabled={pending || justification.trim().length < 3}
                onClick={save}
                className={`rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 ${
                  review.stop ? 'bg-rose text-white' : 'bg-ink text-paper'
                }`}
              >
                {review.stop ? t('stop.button') : t('review.save')}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  )
}
