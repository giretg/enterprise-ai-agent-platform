'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  approveWikiConfigProposalAction,
  rejectWikiConfigProposalAction,
  setWikiAgentConfigChangesAction,
  setWikiCollectFocusAction,
  type getWikiConfigProposalAction,
  type getWikiConfigProposalsAction,
} from '@/app/actions/knowledge-wiki'
import { Card } from '@/components/ui/shell'
import { collapseUnchanged, diffLines } from '@/lib/text-line-diff'
import { WIKI_COLLECT_MAX_CHARS } from '@/lib/wiki-config'
import { formatWhen } from './wiki-format'

type Overview = Extract<Awaited<ReturnType<typeof getWikiConfigProposalsAction>>, { success: true }>['data']
type Review = Extract<Awaited<ReturnType<typeof getWikiConfigProposalAction>>, { success: true }>['data']
type ListDiff = { added: string[]; changed: string[]; removed: string[] }

const PROPOSAL_ERRORS = ['config_conflict', 'invalid_config_change', 'proposal_not_pending', 'conflict', 'forbidden', 'not_found'] as const

function proposalErrorKey(code: string): (typeof PROPOSAL_ERRORS)[number] | 'generic' {
  return (PROPOSAL_ERRORS as readonly string[]).includes(code) ? (code as (typeof PROPOSAL_ERRORS)[number]) : 'generic'
}

const buttonClass = 'rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/60 disabled:opacity-50'
const inputClass = 'w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm'
const choiceClass = (selected: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${selected ? 'border-coral bg-coral/10 text-coral-deep' : 'border-line text-ink hover:border-coral/60'}`

/** #1075: a Javaslatok fül — ki javasolhat, a wiki fókusza, függő és lezárt javaslatok. */
export function WikiProposalsPanel({ connectorId, overview, review }: { connectorId: string; overview: Overview; review: Review | null }) {
  return (
    <div className="space-y-4">
      <SettingCard connectorId={connectorId} enabled={overview.enabled} />
      <CollectCard key={overview.collect ?? ''} connectorId={connectorId} collect={overview.collect} />
      {review ? <ReviewCard key={review.id} connectorId={connectorId} review={review} /> : null}
      <ListCard connectorId={connectorId} overview={overview} selected={review?.id ?? null} />
    </div>
  )
}

function SettingCard({ connectorId, enabled }: { connectorId: string; enabled: boolean }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState(false)
  const change = (next: boolean) =>
    start(async () => {
      const res = await setWikiAgentConfigChangesAction({ connectorId, enabled: next })
      setError(!res.success)
      if (res.success) router.refresh()
    })
  return (
    <Card title={t('settingTitle')}>
      <p className="mb-3 text-sm text-ink-soft">{t('intro')}</p>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('settingTitle')}>
        <button type="button" disabled={pending} onClick={() => change(false)} data-testid="wiki-proposals-off" aria-pressed={!enabled} className={choiceClass(!enabled)}>
          {t('off')}
        </button>
        <button type="button" disabled={pending} onClick={() => change(true)} data-testid="wiki-proposals-on" aria-pressed={enabled} className={choiceClass(enabled)}>
          {t('on')}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-faint">{enabled ? t('onHelp') : t('offHelp')}</p>
      {error ? <p role="alert" className="mt-2 text-sm text-coral-deep">{t('errors.generic')}</p> : null}
    </Card>
  )
}

function CollectCard({ connectorId, collect }: { connectorId: string; collect: string | null }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [text, setText] = useState(collect ?? '')
  const [error, setError] = useState(false)
  const dirty = (text.trim() || null) !== (collect ?? null)
  const save = () =>
    start(async () => {
      const res = await setWikiCollectFocusAction({ connectorId, collect: text.trim() || null })
      setError(!res.success)
      if (res.success) router.refresh()
    })
  return (
    <Card title={t('collectTitle')}>
      <p className="mb-2 text-sm text-ink-soft">{t('collectHelp')}</p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={WIKI_COLLECT_MAX_CHARS} rows={3} placeholder={t('collectEmpty')} data-testid="wiki-collect-focus" className={inputClass} />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={pending || !dirty} onClick={save} className={buttonClass}>{t('collectSave')}</button>
        {error ? <p role="alert" className="text-sm text-coral-deep">{t('errors.generic')}</p> : null}
      </div>
    </Card>
  )
}

function ListCard({ connectorId, overview, selected }: { connectorId: string; overview: Overview; selected: string | null }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  const locale = useLocale()
  const href = (id: string) => `/control-plane/knowledge/${connectorId}?tab=proposals&proposal=${id}`
  return (
    <Card title={t('listTitle')}>
      {overview.pending.length === 0 ? (
        <p className="text-sm text-ink-soft" data-testid="wiki-proposals-empty">{overview.enabled ? t('emptyOn') : t('emptyOff')}</p>
      ) : (
        <ul className="space-y-2">
          {overview.pending.map((row) => (
            <li key={row.id} className="text-sm">
              <Link href={href(row.id)} aria-current={row.id === selected ? 'true' : undefined} className="font-medium text-ink hover:text-coral-deep">
                {t('rowTitle', { agent: row.agentName ?? t('unknownAgent'), count: row.operationCount })}
              </Link>
              <span className="ml-2 text-xs text-ink-faint">{formatWhen(row.createdAt, locale)}</span>
              <p className="text-xs text-ink-soft">{row.note}</p>
            </li>
          ))}
        </ul>
      )}
      {overview.history.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">{t('historyTitle')}</h3>
          <ul className="space-y-1">
            {overview.history.map((row) => (
              <li key={row.id} className="text-sm text-ink-soft">
                <Link href={href(row.id)} className="hover:text-coral-deep">{row.agentName ?? t('unknownAgent')}</Link>
                {' · '}
                {t(`status.${row.status}`)}
                {row.decidedAt ? ` · ${formatWhen(row.decidedAt, locale)}` : ''}
                {row.decisionComment ? ` · ${row.decisionComment}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}

function ReviewCard({ connectorId, review }: { connectorId: string; review: Review }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  const locale = useLocale()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<ReturnType<typeof proposalErrorKey> | null>(null)
  const open = review.status === 'pending'
  const blocked = review.stale || review.issues.length > 0
  const run = (action: () => Promise<{ success: boolean; error?: string }>) =>
    start(async () => {
      const res = await action()
      if (!res.success) setError(proposalErrorKey(res.error ?? ''))
      router.refresh()
    })
  return (
    <Card title={t('reviewTitle', { agent: review.agentName ?? t('unknownAgent') })}>
      <div data-testid="wiki-proposal-review" className="space-y-4">
        <div>
          <p className="text-xs text-ink-faint">{formatWhen(review.createdAt, locale)} · {t(`status.${review.status}`)}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{review.note}</p>
          {review.decisionComment ? <p className="mt-1 text-sm text-ink-soft">{t('decisionComment', { comment: review.decisionComment })}</p> : null}
          {review.decisionReason ? <p className="mt-1 text-sm text-ink-soft">{t(`causes.${proposalErrorKey(review.decisionReason)}`)}</p> : null}
        </div>

        {open && review.stale ? <Notice>{t('stale')}</Notice> : null}
        {open && review.issues.length > 0 ? (
          <Notice>
            {t('invalidNow')}
            <ul className="mt-1 list-disc pl-4">
              {review.issues.map((issue) => <li key={`${issue.index}-${issue.code}`}>{issue.message}</li>)}
            </ul>
          </Notice>
        ) : null}
        {/* A változás-nézet az élő állapotból számolódik, ezért csak függő javaslatnál értelmes. */}
        {open ? (
          <>
          {review.warnings.map((code) => <Notice key={code}>{t(`warnings.${code === 'managed_fields_off' ? 'managed_fields_off' : 'managed_categories_off'}`)}</Notice>)}
          {review.destructive.map((row, index) => (
            <Notice key={index}>
              {row.kind === 'merge'
                ? t('destructive.merge', { from: row.from, to: row.to, count: row.pageCount })
                : row.kind === 'rename_option'
                  ? t('destructive.rename', { field: row.field, from: row.from, to: row.to, count: row.pageCount })
                  : t('destructive.remove', { field: row.field, option: row.option, to: row.remapTo ?? '—', count: row.pageCount })}
            </Notice>
          ))}

          <Section title={t('sections.nameFocus')} empty={!review.diff.name && !review.diff.collect}>
            {review.diff.name ? <Change label={t('name')} from={review.diff.name.from} to={review.diff.name.to} /> : null}
            {review.diff.collect ? <Change label={t('collect')} from={review.diff.collect.from} to={review.diff.collect.to} /> : null}
          </Section>
          <Section title={t('sections.wikiMd')} empty={!review.diff.wikiMd}>
            {review.diff.wikiMd ? <TextDiff from={review.diff.wikiMd.from} to={review.diff.wikiMd.to} /> : null}
          </Section>
          <KeyList title={t('sections.groups')} diff={review.diff.groups} />
          <KeyList title={t('sections.categories')} diff={review.diff.categories} />
          <KeyList title={t('sections.fields')} diff={review.diff.fields} />
          <KeyList title={t('sections.templates')} diff={review.diff.templates} />
          <Section title={t('sections.pages')} empty={review.pageChanges.length === 0}>
            <ul className="space-y-0.5 text-sm text-ink-soft">
              {review.pageChanges.map((page) => (
                <li key={page.path}>
                  <code className="text-xs">{page.path}</code>
                  {page.fromCategory !== page.toCategory ? ` : ${page.fromCategory ?? '—'} → ${page.toCategory ?? '—'}` : ''}
                  {page.fieldsRewritten ? ` (${t('fieldsRewritten')})` : ''}
                </li>
              ))}
            </ul>
          </Section>
          </>
        ) : null}

        {open ? (
          <div className="space-y-2 border-t border-line/70 pt-3">
            <label className="block text-sm text-ink-soft">
              {t('commentLabel')}
              <textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={2} className={`${inputClass} mt-1`} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={pending || blocked} onClick={() => run(() => approveWikiConfigProposalAction({ connectorId, proposalId: review.id }))} data-testid="wiki-proposal-approve" className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {t('approve')}
              </button>
              <button type="button" disabled={pending} onClick={() => run(() => rejectWikiConfigProposalAction({ connectorId, proposalId: review.id, comment }))} data-testid="wiki-proposal-reject" className={buttonClass}>
                {t('reject')}
              </button>
            </div>
            <p className="text-xs text-ink-faint">{t('approveHelp')}</p>
            {error ? <p role="alert" className="text-sm text-coral-deep">{t(`errors.${error}`)}</p> : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-coral/40 bg-coral/5 px-3 py-2 text-sm text-coral-deep">{children}</div>
}

function Section({ title, empty, children }: { title: string; empty: boolean; children?: React.ReactNode }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">{title}</h3>
      {empty ? <p className="text-xs text-ink-faint">{t('noChange')}</p> : children}
    </section>
  )
}

function Change({ label, from, to }: { label: string; from: string | null; to: string | null }) {
  return <p className="whitespace-pre-wrap text-sm text-ink">{label}: <span className="text-ink-faint line-through">{from ?? '—'}</span> → {to ?? '—'}</p>
}

function KeyList({ title, diff }: { title: string; diff: ListDiff }) {
  const t = useTranslations('ControlPlane.wiki.proposals')
  const rows = [
    { label: t('added'), keys: diff.added },
    { label: t('changed'), keys: diff.changed },
    { label: t('removed'), keys: diff.removed },
  ].filter((row) => row.keys.length > 0)
  return (
    <Section title={title} empty={rows.length === 0}>
      {rows.map((row) => (
        <p key={row.label} className="text-sm text-ink-soft">
          <span className="font-medium text-ink">{row.label} ({row.keys.length}):</span> {row.keys.join(', ')}
        </p>
      ))}
    </Section>
  )
}

function TextDiff({ from, to }: { from: string; to: string }) {
  const t = useTranslations('ControlPlane.wiki')
  const rows = collapseUnchanged(diffLines(from, to))
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-line/70 p-2 font-mono text-xs">
      {rows.map((row, index) =>
        row.kind === 'skip' ? (
          <div key={index} className="text-ink-faint">{t('review.unchangedLines', { count: row.count })}</div>
        ) : (
          <div key={index} className={row.kind === 'add' ? 'bg-sage/15 text-ink' : row.kind === 'del' ? 'bg-coral/10 text-coral-deep line-through decoration-coral/40' : 'text-ink-soft'}>
            {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  '}{row.text || ' '}
          </div>
        ),
      )}
    </div>
  )
}
