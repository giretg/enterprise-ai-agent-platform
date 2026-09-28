'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { decideHandoffAction, type HandoffInboxRow } from '@/app/actions/handoff'
import { parseHandoffLinks } from '@/domain/handoff/handoff-service'
import { asTranslate } from '@/i18n/translate'
import { GENERAL_WORK_PROJECT_KEY } from '@/lib/work-project'
import { Badge } from '@/components/ui/shell'
import { operationErrorLabel } from './labels'

type Decision = 'accepted' | 'done' | 'rejected'

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU')
}

function decisionsFor(status: string): Decision[] {
  if (status === 'accepted') return ['done', 'rejected']
  return ['accepted', 'done', 'rejected']
}

function statusTone(status: string): 'warning' | 'success' | 'neutral' {
  if (status === 'accepted') return 'success'
  if (status === 'open') return 'warning'
  return 'neutral'
}

function HandoffLinks({ raw }: { raw: string | null }) {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const items = parseHandoffLinks(raw)
  if (items.length === 0) return null
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {items.map((item) => (
        <li key={`${item.label}:${item.href}`}>
          {item.kind === 'url' ? (
            <a
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="text-coral-deep underline decoration-coral/40 underline-offset-2 hover:decoration-coral"
            >
              {item.label}
            </a>
          ) : item.kind === 'work_file' ? (
            <Link
              href="/control-plane/projects"
              className="text-coral-deep underline decoration-coral/40 underline-offset-2 hover:decoration-coral"
              title={item.href.replace(/^work_file:/, '')}
            >
              {item.label} · {t('handoffWorkFile')}
            </Link>
          ) : (
            <span className="text-ink-soft">{item.label}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

export function HandoffsPanel({ handoffs }: { handoffs: HandoffInboxRow[] }) {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const locale = useLocale()
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [messageKind, setMessageKind] = useState<'info' | 'error'>('info')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Record<string, true>>({})
  const [statusById, setStatusById] = useState<Record<string, string>>({})

  const visible = handoffs.filter((row) => !hidden[row.id])

  async function onDecide(handoffId: string, decision: Decision) {
    setBusyId(handoffId)
    setMessage(null)
    const result = await decideHandoffAction({ handoffId, decision })
    setBusyId(null)
    if (!result.success) {
      setMessageKind('error')
      setMessage(operationErrorLabel(result.error, t))
      return
    }
    setMessageKind('info')
    setMessage(t(`handoffDecided_${decision}`))
    if (decision === 'done' || decision === 'rejected') {
      setHidden((current) => ({ ...current, [handoffId]: true }))
    } else {
      setStatusById((current) => ({ ...current, [handoffId]: decision }))
    }
    router.refresh()
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold">{t('handoffsTitle')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('handoffsBody')}</p>
      </div>
      {message ? (
        <p
          className={
            messageKind === 'error'
              ? 'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
              : 'rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink'
          }
        >
          {message}
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('handoffsEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {visible.map((row) => {
            const status = statusById[row.id] ?? row.status
            const busy = busyId === row.id
            const projectLabel =
              row.projectKey === GENERAL_WORK_PROJECT_KEY ? t('handoffGeneralProject') : row.projectKey
            return (
              <li key={row.id} className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-ink">{row.title}</p>
                  <p className="text-xs text-ink-faint">{formatWhen(row.createdAt, locale)}</p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                  <Badge tone={statusTone(status)} title={t(`handoffStatusHint_${status}`)}>
                    {t(`handoffStatus_${status}`)}
                  </Badge>
                  <span>{t('handoffFrom', { name: row.fromAgentName })}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t('handoffProject', { name: projectLabel })}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{row.summary}</p>
                <HandoffLinks raw={row.links} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {decisionsFor(status).map((decision) => {
                    const primary = decision === 'accepted' || (status === 'accepted' && decision === 'done')
                    return (
                      <button
                        key={decision}
                        type="button"
                        disabled={busy}
                        title={t(`handoffHint_${decision}`)}
                        onClick={() => void onDecide(row.id, decision)}
                        className={
                          primary
                            ? 'rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50'
                            : 'rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50'
                        }
                      >
                        {t(`handoff_${decision}`)}
                      </button>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
