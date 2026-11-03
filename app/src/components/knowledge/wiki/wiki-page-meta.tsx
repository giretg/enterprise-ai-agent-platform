'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { reviewWikiPageAction, setWikiPageMetaAction } from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { formatWhen } from './wiki-format'

type DocStatus = 'draft' | 'approved'

export type WikiPageMetaData = {
  managed: boolean
  docStatus: DocStatus | null
  owner: { userId: string; name: string | null; role: string | null } | null
  lastReviewed: { at: string; by: string | null } | null
  ownCycleDays: number | null
  categoryCycleDays: number | null
  cycleDays: number | null
  reviewDue: string | null
  reviewOverdue: boolean
  fields: Array<{ key: string; name: string; type: string; help: string | null; value: unknown }>
  requiredFields: string[]
  canReview: boolean
  canCurate: boolean
  users: Array<{ id: string; label: string }>
}

const inputClass = 'w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm'

function fieldText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value)) return value.length ? value.join(', ') : null
  return String(value)
}

/**
 * #1061 F3: az oldal metaadatai — állapot, gazda, átnézés, egyedi mezők. Az
 * „Átnéztem, rendben” emberi tanúsítás; az agent ilyet nem tud tenni.
 */
export function WikiPageMeta({ connectorId, path, data, locale }: { connectorId: string; path: string; data: WikiPageMetaData; locale: string }) {
  const t = useTranslations('ControlPlane.wiki.pageMeta')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [docStatus, setDocStatus] = useState<DocStatus | ''>(data.docStatus ?? '')
  const [ownerUserId, setOwnerUserId] = useState(data.owner?.userId ?? '')
  const [ownerRole, setOwnerRole] = useState(data.owner?.role ?? '')
  const [cycle, setCycle] = useState(data.ownCycleDays ? String(data.ownCycleDays) : '')

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, okText: string, after?: () => void) =>
    start(async () => {
      setMessage(null)
      const res = await fn()
      if (!res.success) {
        setMessage({ kind: 'error', text: t(res.error === 'conflict' ? 'errors.conflict' : res.error === 'forbidden' ? 'errors.forbidden' : 'errors.generic') })
        return
      }
      setMessage({ kind: 'ok', text: okText })
      after?.()
      router.refresh()
    })

  const filled = data.fields.filter((field) => fieldText(field.value) !== null)
  const missing = data.requiredFields.filter((key) =>
    key === 'owner' ? !data.owner : fieldText(data.fields.find((field) => field.key === key)?.value) === null,
  )

  return (
    <section className="mt-4 rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm" data-testid="wiki-page-meta">
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-soft">{t('status')}</dt>
          <dd data-testid="wiki-page-doc-status">
            {data.docStatus ? (
              <span className={`rounded-full px-2 text-xs ${data.docStatus === 'approved' ? 'bg-sage/15 text-sage' : 'bg-amber-100 text-amber-800'}`}>
                {t(`statuses.${data.docStatus}`)}
              </span>
            ) : (
              <span className="text-ink-faint">{t('statusNone')}</span>
            )}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-soft">{t('owner')}</dt>
          <dd className="text-ink">
            {data.owner ? `${data.owner.name ?? '—'}${data.owner.role ? ` · ${data.owner.role}` : ''}` : <span className="text-ink-faint">{t('ownerNone')}</span>}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-soft">{t('lastReviewed')}</dt>
          <dd className="text-ink" data-testid="wiki-page-last-reviewed">
            {data.lastReviewed
              ? `${formatWhen(data.lastReviewed.at, locale)}${data.lastReviewed.by ? ` · ${data.lastReviewed.by}` : ` · ${t('reviewedImported')}`}`
              : <span className="text-ink-faint">{t('neverReviewed')}</span>}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-x-2">
          <dt className="flex items-center text-ink-soft">
            {t('nextReview')}
            <HelpHint>{t('nextReviewHelp')}</HelpHint>
          </dt>
          <dd>
            {data.reviewDue ? (
              <span className={data.reviewOverdue ? 'font-medium text-coral-deep' : 'text-ink'} data-testid="wiki-page-review-due">
                {formatWhen(data.reviewDue, locale).split(',')[0]}
                {data.reviewOverdue ? ` · ${t('overdue')}` : ''}
                {` · ${t('cycle', { days: data.cycleDays ?? 0 })}`}
              </span>
            ) : (
              <span className="text-ink-faint">{t('noCycle')}</span>
            )}
          </dd>
        </div>
        {filled.map((field) => (
          <div key={field.key} className="flex flex-wrap gap-x-2">
            <dt className="text-ink-soft">{field.name}</dt>
            <dd className="text-ink">{fieldText(field.value)}</dd>
          </div>
        ))}
      </dl>
      {missing.length ? (
        <p className="mt-1 text-xs text-amber-800" data-testid="wiki-page-missing-fields">
          {t('missingFields', {
            fields: missing.map((key) => (key === 'owner' ? t('owner') : data.fields.find((field) => field.key === key)?.name ?? key)).join(', '),
          })}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {data.canReview && data.managed ? (
          <button
            type="button"
            disabled={pending}
            data-testid="wiki-page-review"
            onClick={() => run(() => reviewWikiPageAction({ connectorId, path }), t('reviewed'))}
            className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
            title={t('reviewHelp')}
          >
            {t('review')}
          </button>
        ) : null}
        {data.canCurate && data.managed ? (
          <button type="button" onClick={() => setEditing(!editing)} className="text-xs text-coral-deep hover:underline" data-testid="wiki-page-meta-edit">
            {editing ? tw('common.close') : t('edit')}
          </button>
        ) : null}
        {!data.managed ? <span className="text-xs text-ink-faint">{t('fieldsOff')}</span> : null}
      </div>

      {editing ? (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            const cycleValue = cycle.trim() ? Math.max(1, Math.min(3650, Math.floor(Number(cycle)) || 0)) || null : null
            run(
              () =>
                setWikiPageMetaAction({
                  connectorId,
                  path,
                  ...(docStatus !== (data.docStatus ?? '') ? { docStatus: docStatus || null } : {}),
                  ...(ownerUserId !== (data.owner?.userId ?? '') ? { ownerUserId: ownerUserId || null } : {}),
                  ...(ownerRole !== (data.owner?.role ?? '') ? { ownerRole: ownerRole || null } : {}),
                  ...(cycleValue !== data.ownCycleDays ? { reviewCycleDays: cycleValue } : {}),
                }),
              t('saved'),
              () => setEditing(false),
            )
          }}
        >
          <label className="text-sm">
            <span className="mb-1 flex items-center text-ink">
              {t('status')}
              <HelpHint>{t('statusHelp')}</HelpHint>
            </span>
            <select value={docStatus} onChange={(e) => setDocStatus(e.target.value as DocStatus | '')} className={inputClass}>
              <option value="">{t('statusNone')}</option>
              <option value="draft">{t('statuses.draft')}</option>
              <option value="approved">{t('statuses.approved')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 flex items-center text-ink">
              {t('cycleLabel')}
              <HelpHint>{t('cycleHelp')}</HelpHint>
            </span>
            <input
              type="number"
              min={1}
              max={3650}
              value={cycle}
              onChange={(e) => setCycle(e.target.value)}
              placeholder={data.categoryCycleDays ? t('cycleFromCategory', { days: data.categoryCycleDays }) : t('cycleNone')}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-ink">{t('owner')}</span>
            <select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} className={inputClass}>
              <option value="">{t('ownerNone')}</option>
              {data.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-ink">{t('roleLabel')}</span>
            <input value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)} maxLength={120} disabled={!ownerUserId} placeholder={t('rolePlaceholder')} className={inputClass} />
          </label>
          {docStatus === 'approved' && data.docStatus !== 'approved' ? (
            <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft sm:col-span-2">{t('approvePreview')}</p>
          ) : null}
          <div className="sm:col-span-2">
            <button type="submit" disabled={pending} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {pending ? tw('common.saving') : tw('common.save')}
            </button>
          </div>
        </form>
      ) : null}

      {message ? (
        <p className={`mt-2 text-xs ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`} role="status">
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
