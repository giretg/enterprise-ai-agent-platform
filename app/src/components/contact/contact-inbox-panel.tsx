'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { markContactInquiryReviewed } from '@/app/actions/contact-inquiries'
import { formatDateTime } from '@/i18n/format'
import { Badge } from '@/components/ui/shell'

type Inquiry = {
  id: string
  name: string
  phone: string
  email: string
  message: string
  status: 'new' | 'reviewed'
  createdAt: string
  reviewedAt: string | null
}

export function ContactInboxPanel({ inquiries, canManage }: { inquiries: Inquiry[]; canManage: boolean }) {
  const t = useTranslations('PlatformContact')
  const locale = useLocale()
  const router = useRouter()
  const [reviewedIds, setReviewedIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState(inquiries[0]?.id ?? '')
  const [filter, setFilter] = useState<'all' | 'new'>('all')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const items = useMemo(
    () => inquiries.map((item) => reviewedIds.includes(item.id)
      ? { ...item, status: 'reviewed' as const, reviewedAt: item.reviewedAt ?? new Date().toISOString() }
      : item),
    [inquiries, reviewedIds],
  )
  const newCount = useMemo(() => items.filter((item) => item.status === 'new').length, [items])
  const visibleItems = useMemo(() => filter === 'new' ? items.filter((item) => item.status === 'new') : items, [filter, items])
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null

  const markReviewed = (inquiryId: string) => {
    setError(null)
    startTransition(async () => {
      const result = await markContactInquiryReviewed({ inquiryId })
      if (!result.success) {
        setError(result.error)
        return
      }
      setReviewedIds((current) => current.includes(inquiryId) ? current : [...current, inquiryId])
      router.refresh()
    })
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-[0_16px_50px_-38px_rgba(17,24,39,0.4)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4zM4 7l8 6 8-6" /></svg>
        </div>
        <div className="mr-auto">
          <p className="text-sm font-semibold text-ink">{t('inboxTitle')}</p>
          <p className="mt-0.5 text-xs text-ink-faint">{t('inboxCount', { count: items.length })}</p>
        </div>
        {newCount > 0 && <Badge tone="warning">{t('newCount', { count: newCount })}</Badge>}
        <div className="flex rounded-lg border border-line bg-card-2 p-1" role="group" aria-label={t('filterLabel')}>
          {(['all', 'new'] as const).map((option) => (
            <button key={option} type="button" onClick={() => setFilter(option)} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${filter === option ? 'bg-white text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}>
              {option === 'all' ? t('filterAll') : t('filterNew')}
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="mx-5 mt-4 rounded-lg border border-rose/20 bg-rose/5 p-3 text-sm text-rose sm:mx-6">{error}</p>}

      {items.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-night-2 text-ink-faint" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4zM4 7l8 6 8-6" /></svg>
          </span>
          <h2 className="mt-4 text-base font-semibold text-ink">{t('emptyTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('emptyBody')}</p>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="px-6 py-14 text-center text-sm text-ink-soft">{t('emptyNew')}</div>
      ) : (
        <div className="grid min-h-[560px] md:grid-cols-[300px_minmax(0,1fr)]">
          <div className="border-b border-line md:border-b-0 md:border-r">
            <div className="max-h-[680px] overflow-y-auto p-2.5">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`mb-1 block w-full rounded-xl border p-3.5 text-left transition ${selected?.id === item.id ? 'border-coral/30 bg-coral/[0.045]' : 'border-transparent hover:border-line hover:bg-card-2'}`}
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.status === 'new' ? 'bg-coral' : 'bg-line'}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{item.name}</span>
                        {item.status === 'new' && <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[10px] font-semibold text-coral-deep">{t('statusNew')}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-soft">{item.email}</span>
                      <span className="mt-2 block font-mono text-[10px] text-ink-faint">{formatDateTime(item.createdAt, locale)}</span>
                      <span className="mt-2 line-clamp-2 block text-xs leading-relaxed text-ink-faint">{item.message}</span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selected ? (
            <article className="flex flex-col p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
                <div className="flex min-w-0 items-start gap-3.5">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-ink text-base font-bold text-white">{selected.name.trim().slice(0, 1).toLocaleUpperCase(locale)}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold tracking-[-0.03em] text-ink">{selected.name}</h2>
                      <Badge tone={selected.status === 'new' ? 'warning' : 'success'}>{selected.status === 'new' ? t('statusNew') : t('statusReviewed')}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-soft">{t('receivedAt', { date: formatDateTime(selected.createdAt, locale) })}</p>
                  </div>
                </div>
                {canManage && selected.status === 'new' && (
                  <button type="button" disabled={pending} onClick={() => markReviewed(selected.id)} className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-semibold text-ink-soft transition hover:border-sage/40 hover:bg-sage/5 hover:text-sage disabled:opacity-50">
                    <span aria-hidden>✓</span>{pending ? t('saving') : t('markReviewed')}
                  </button>
                )}
              </div>

              <div className="grid gap-3 border-b border-line py-5 sm:grid-cols-2">
                <a href={`mailto:${selected.email}`} className="group rounded-xl border border-line bg-card-2/50 p-3.5 transition hover:border-coral/25 hover:bg-coral/[0.025]">
                  <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">{t('email')}</span>
                  <span className="mt-1.5 block truncate text-sm font-semibold text-ink group-hover:text-coral-deep">{selected.email}</span>
                </a>
                <a href={`tel:${selected.phone.replace(/[^\d+]/g, '')}`} className="group rounded-xl border border-line bg-card-2/50 p-3.5 transition hover:border-coral/25 hover:bg-coral/[0.025]">
                  <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">{t('phone')}</span>
                  <span className="mt-1.5 block text-sm font-semibold text-ink group-hover:text-coral-deep">{selected.phone}</span>
                </a>
              </div>

              <div className="flex-1 py-6">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{t('message')}</p>
                <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-ink-soft">{selected.message}</p>
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs text-ink-faint">{selected.status === 'reviewed' && selected.reviewedAt ? t('reviewedAt', { date: formatDateTime(selected.reviewedAt, locale) }) : t('keepInTouch')}</p>
                <a href={`mailto:${selected.email}?subject=${encodeURIComponent(t('replySubject'))}`} className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-coral">{t('reply')} <span aria-hidden>↗</span></a>
              </div>
            </article>
          ) : null}
        </div>
      )}
    </div>
  )
}
