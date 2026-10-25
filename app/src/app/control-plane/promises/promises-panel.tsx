'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { resolveCustomerPromiseAction, type CustomerPromiseRow } from '@/app/actions/customer-promise'
import { formatDateTime } from '@/i18n/format'
import { Badge } from '@/components/ui/shell'

export function PromisesPanel({ promises, pagination }: { promises: CustomerPromiseRow[]; pagination?: { page: number; hasMore: boolean; pageHref: string } }) {
  const t = useTranslations('ControlPlane.promises')
  const locale = useLocale()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  function resolve(promiseId: string, status: 'fulfilled' | 'cancelled') {
    setMessage(null)
    startTransition(async () => {
      try {
        const result = await resolveCustomerPromiseAction({ promiseId, status, note })
        if (!result.success) {
          setMessage(t('error'))
          return
        }
        setEditingId(null)
        setNote('')
      } catch {
        setMessage(t('error'))
      }
    })
  }

  return (
    <section className="space-y-4">
      <details className="max-w-3xl text-sm text-ink-soft">
        <summary className="cursor-pointer font-medium text-ink">? {t('helpLabel')}</summary>
        <p className="mt-2">{t('help')}</p>
      </details>
      {message ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{message}</p> : null}
      {promises.length === 0 ? <p className="text-sm text-ink-soft">{t(pagination && pagination.page > 0 ? 'pageEmpty' : 'empty')}</p> : (
        <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white/50">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="border-b border-ink/10 text-ink-soft">
              <tr>{(['commitment', 'customer', 'agent', 'dueAt', 'status', 'owner', 'actions'] as const).map((key) => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(key)}</th>)}</tr>
            </thead>
            <tbody>
              {promises.map((row) => (
                <tr key={row.id} className="border-b border-ink/10 align-top last:border-0">
                  <td className="min-w-60 max-w-md px-4 py-4">
                    <p className="font-medium">{row.title}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-ink-soft">{row.commitment}</p>
                    {row.resolvedNote ? <p className="mt-2 whitespace-pre-wrap text-ink-soft">{row.resolvedNote}</p> : null}
                  </td>
                  <td className="px-4 py-4"><p>{row.customerName ?? '—'}</p><p className="text-ink-soft">{row.customerEmail}</p></td>
                  <td className="px-4 py-4"><Link className="text-coral-deep underline" href={`/control-plane/agents/${row.agentId}?section=igeretek`}>{row.agentName}</Link></td>
                  <td className="whitespace-nowrap px-4 py-4"><time dateTime={row.dueAt}>{formatDateTime(row.dueAt, locale, row.timezone)}</time><p className="mt-1 text-xs text-ink-faint">{row.timezone}</p></td>
                  <td className="px-4 py-4"><Badge tone={row.displayStatus === 'overdue' || row.displayStatus === 'missed' ? 'warning' : row.status === 'fulfilled' ? 'success' : 'neutral'}>{t(`statuses.${row.displayStatus}`)}</Badge></td>
                  <td className="px-4 py-4">{row.ownerName}</td>
                  <td className="min-w-48 px-4 py-4">
                    {row.canResolve ? editingId === row.id ? (
                      <div className="space-y-2">
                        <label className="block text-ink-soft" htmlFor={`note-${row.id}`}>{t('note')}</label>
                        <textarea id={`note-${row.id}`} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className="w-full rounded-md border border-ink/20 p-2" disabled={pending} />
                        <button type="button" disabled={pending} onClick={() => resolve(row.id, 'fulfilled')} className="rounded-md bg-ink px-3 py-2 text-white disabled:opacity-50">{t('complete')}</button>
                        <button type="button" disabled={pending} onClick={() => resolve(row.id, 'cancelled')} className="rounded-md border border-ink/20 px-3 py-2 disabled:opacity-50">{t('cancel')}</button>
                        <button type="button" disabled={pending} onClick={() => setEditingId(null)} className="px-3 py-2 underline">{t('back')}</button>
                      </div>
                    ) : <button type="button" disabled={pending} onClick={() => { setEditingId(row.id); setNote('') }} className="rounded-md border border-ink/20 px-3 py-2">{t('resolve')}</button> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagination && (pagination.page > 0 || pagination.hasMore) ? (
        <nav aria-label={t('pagination')} className="flex items-center gap-4 text-sm">
          {pagination.page > 0 ? <Link className="underline" href={`${pagination.pageHref}${pagination.page - 1}`}>{t('previous')}</Link> : null}
          <span>{t('page', { page: pagination.page + 1 })}</span>
          {pagination.hasMore ? <Link className="underline" href={`${pagination.pageHref}${pagination.page + 1}`}>{t('next')}</Link> : null}
        </nav>
      ) : null}
    </section>
  )
}
