'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { updateWikiRetentionAction } from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

type Retention = {
  retentionFullDays: number
  retentionDeleteDays: number | null
  fullOptions: number[]
  deleteOptions: number[]
  keepLatest: number
}

/** #978 §6 (D1): „Régi verziók megőrzése” — wikinként, közérthető választókkal. */
export function WikiRetentionPanel({ connectorId, retention }: { connectorId: string; retention: Retention }) {
  const t = useTranslations('ControlPlane.wiki.history.retention')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [full, setFull] = useState(retention.retentionFullDays)
  const [del, setDel] = useState<number | null>(retention.retentionDeleteDays)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [pending, start] = useTransition()
  const label = (days: number) => (days % 365 === 0 ? t('years', { count: days / 365 }) : t('days', { count: days }))
  const invalid = del !== null && del < full
  const changed = full !== retention.retentionFullDays || del !== retention.retentionDeleteDays

  return (
    <Card title={t('title')}>
      <form
        className="space-y-3"
        data-testid="wiki-retention-form"
        onSubmit={(event) => {
          event.preventDefault()
          start(async () => {
            setMessage(null)
            const res = await updateWikiRetentionAction({ connectorId, retentionFullDays: full, retentionDeleteDays: del })
            if (!res.success) {
              setMessage({ kind: 'error', text: tw(`errors.${errorKey(res.error)}`) })
              return
            }
            setMessage({ kind: 'ok', text: t('saved') })
            router.refresh()
          })
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 flex items-center text-ink">
            {t('fullLabel')}
            <HelpHint>{t('fullHelp')}</HelpHint>
          </span>
          <select
            value={full}
            onChange={(event) => setFull(Number(event.target.value))}
            data-testid="wiki-retention-full"
            className="rounded-lg border border-line/70 px-3 py-1.5 text-sm"
          >
            {retention.fullOptions.map((days) => (
              <option key={days} value={days}>
                {label(days)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 flex items-center text-ink">
            {t('deleteLabel')}
            <HelpHint>{t('deleteHelp')}</HelpHint>
          </span>
          <select
            value={del === null ? 'never' : String(del)}
            onChange={(event) => setDel(event.target.value === 'never' ? null : Number(event.target.value))}
            data-testid="wiki-retention-delete"
            className="rounded-lg border border-line/70 px-3 py-1.5 text-sm"
          >
            {retention.deleteOptions.map((days) => (
              <option key={days} value={days} disabled={days < full}>
                {label(days)}
              </option>
            ))}
            <option value="never">{t('never')}</option>
          </select>
        </label>
        <p className="text-xs text-ink-faint">{t('alwaysKept', { count: retention.keepLatest })}</p>
        {invalid ? <p className="text-xs text-coral-deep">{t('deleteTooShort')}</p> : null}
        {message ? (
          <p className={`text-sm ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`}>{message.text}</p>
        ) : null}
        <button
          type="submit"
          disabled={pending || invalid || !changed}
          data-testid="wiki-retention-save"
          className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {pending ? tw('common.saving') : tw('common.save')}
        </button>
      </form>
    </Card>
  )
}
