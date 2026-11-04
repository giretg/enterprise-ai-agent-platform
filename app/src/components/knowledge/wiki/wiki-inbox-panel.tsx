'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import {
  listWikiInboxAction,
  skipWikiInboxItemAction,
  requestWikiReprocessAction,
  cancelWikiReprocessAction,
  uploadWikiInboxFileAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'
import { formatWhen, wikiHref } from './wiki-format'
import { MAX_INBOX_FILE_BYTES, uploadInboxFile } from './wiki-inbox-upload'

const POLL_MS = 10_000
const PARALLEL_UPLOADS = 3

export type WikiInboxData = {
  canManage: boolean
  canContribute: boolean
  totals: { pending: number; reprocess: number; inProgress: number; processed: number; skipped: number }
  batches: Array<{
    batchId: string
    pending: number
    reprocess: number
    inProgress: number
    processed: number
    skipped: number
    total: number
    createdAt: string | null
  }>
  items: Array<{
    documentId: string
    filename: string
    purpose: string | null
    status: 'pending' | 'reprocess' | 'in_progress' | 'processed' | 'skipped'
    submittedBy: { kind: 'agent' | 'human'; name: string | null }
    claimedBy: string | null
    submittedAt: string
    batchId: string | null
    /** #1077: már vannak oldalak ebből a forrásból, de a tétel nincs lezárva. */
    partlyWritten: { pageCount: number; pages: Array<{ path: string; title: string }> } | null
    /** #1085: a legutóbbi újrafeldolgozási kérés (lezárt tételen előzmény). */
    reprocess: {
      reason: string
      requestedAt: string
      requestedBy: { kind: 'agent' | 'human'; name: string | null }
      outcome: 'unchanged' | null
    } | null
    stale: boolean
  }>
}

type UploadState = {
  total: number
  done: number
  queued: number
  duplicates: string[]
  tooLarge: string[]
  empty: string[]
  unreadable: string[]
  interrupted: string[]
  rejected: Array<{ name: string; reason: ReturnType<typeof errorKey> }>
}

function listNames(names: string[]) {
  const shown = names.slice(0, 5).join(', ')
  return names.length > 5 ? `${shown} +${names.length - 5}` : shown
}

export function WikiInboxPanel({ connectorId, initial }: { connectorId: string; initial: WikiInboxData }) {
  const t = useTranslations('ControlPlane.wiki')
  const locale = useLocale()
  const [data, setData] = useState(initial)
  const [upload, setUpload] = useState<UploadState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reprocessFormId, setReprocessFormId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    const res = await listWikiInboxAction({ connectorId })
    if (res.success) setData(res.data)
  }, [connectorId])

  // A köteg-állás magától frissül, amíg van váró vagy feldolgozás alatti tétel.
  const active = data.totals.pending + data.totals.reprocess + data.totals.inProgress > 0 || upload !== null
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [active, reload])

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setError(null)
    const tooLarge = files.filter((file) => file.size > MAX_INBOX_FILE_BYTES).map((file) => file.name)
    const queue = files.filter((file) => file.size > 0 && file.size <= MAX_INBOX_FILE_BYTES)
    const empty = files.filter((file) => file.size === 0).map((file) => file.name)
    const state: UploadState = {
      total: files.length,
      done: tooLarge.length + empty.length,
      queued: 0,
      duplicates: [],
      tooLarge,
      empty,
      unreadable: [],
      interrupted: [],
      rejected: [],
    }
    setUpload({ ...state })
    const batchId = crypto.randomUUID()
    let next = 0
    async function worker() {
      while (next < queue.length) {
        const seq = next++
        const file = queue[seq]
        const outcome = await uploadInboxFile(file, (copy) => {
          const form = new FormData()
          form.set('connectorId', connectorId)
          form.set('batchId', batchId)
          form.set('batchSeq', String(seq))
          form.set('file', copy)
          return uploadWikiInboxFileAction(form)
        })
        if (outcome.kind === 'queued') state.queued++
        else if (outcome.kind === 'duplicate') state.duplicates.push(file.name)
        else if (outcome.kind === 'unreadable') state.unreadable.push(file.name)
        else if (outcome.kind === 'interrupted') state.interrupted.push(file.name)
        else if (outcome.error === 'too_large') state.tooLarge.push(file.name)
        else state.rejected.push({ name: file.name, reason: errorKey(outcome.error) })
        state.done++
        setUpload({ ...state })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, worker))
    await reload()
    setUpload({ ...state })
  }

  function pickFiles(list: FileList | null) {
    void uploadFiles(Array.from(list ?? []))
  }

  const latest = data.batches[0]
  const pendingItems = data.items.filter((item) => item.status === 'pending' || item.status === 'reprocess' || item.status === 'in_progress')
  const doneItems = data.items.filter((item) => item.status === 'processed' || item.status === 'skipped')

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex items-center gap-1">
          <h2 className="font-display text-lg font-semibold">{t('inbox.title')}</h2>
          <HelpHint>{t('inbox.help')}</HelpHint>
        </div>
        <p className="mb-4 max-w-2xl text-sm text-ink-soft">{t('inbox.intro')}</p>

        {data.canContribute ? (
          <div
            data-testid="wiki-inbox-dropzone"
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              pickFiles(event.dataTransfer.files)
            }}
            className={`rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm ${
              dragging ? 'border-coral bg-coral/5' : 'border-line'
            }`}
          >
            <p className="font-medium text-ink">{t('inbox.dropHere')}</p>
            <p className="mt-1 text-xs text-ink-faint">{t('inbox.limit')}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={upload !== null && upload.done < upload.total}
                className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('inbox.pickFiles')}
              </button>
              <button
                type="button"
                onClick={() => folderInput.current?.click()}
                disabled={upload !== null && upload.done < upload.total}
                className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {t('inbox.pickFolder')}
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="wiki-inbox-file-input"
              onChange={(event) => {
                pickFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              hidden
              // Mappa-feltöltés (Chrome, Edge, Safari, Firefox).
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => {
                pickFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-soft">{t('inbox.readOnly')}</p>
        )}

        {upload ? (
          <div className="mt-3 space-y-1 text-sm" data-testid="wiki-upload-progress">
            <p className="text-ink">
              {upload.done < upload.total
                ? t('inbox.uploading', { done: upload.done, total: upload.total })
                : upload.queued > 0
                  ? t('inbox.uploaded', { total: upload.queued })
                  : t('inbox.uploadedNone')}
            </p>
            {upload.duplicates.length ? (
              <p className="text-xs text-amber-800">{t('inbox.duplicates', { count: upload.duplicates.length, names: listNames(upload.duplicates) })}</p>
            ) : null}
            {upload.tooLarge.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.tooLarge', { count: upload.tooLarge.length, names: listNames(upload.tooLarge) })}</p>
            ) : null}
            {upload.empty.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.emptyFile', { count: upload.empty.length, names: listNames(upload.empty) })}</p>
            ) : null}
            {upload.unreadable.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.unreadable', { count: upload.unreadable.length, names: listNames(upload.unreadable) })}</p>
            ) : null}
            {upload.interrupted.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.interrupted', { count: upload.interrupted.length, names: listNames(upload.interrupted) })}</p>
            ) : null}
            {(['not_found', 'forbidden', 'invalid_args', 'too_large', 'generic'] as const).map((reason) => {
              const names = upload.rejected.filter((item) => item.reason === reason).map((item) => item.name)
              return names.length ? (
                <p key={reason} className="text-xs text-coral-deep">{t('inbox.rejected', { reason: t(`errors.${reason}`), names: listNames(names) })}</p>
              ) : null
            })}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
        {notice ? <p className="mt-2 text-sm text-ink-soft" data-testid="wiki-inbox-notice">{notice}</p> : null}
      </Card>

      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{t('inbox.statusTitle')}</h3>
          <span className="text-xs text-ink-faint">{active ? t('inbox.autoRefresh') : null}</span>
        </div>
        {latest ? (
          <BatchBar batch={latest} label={t('inbox.latestBatch')} />
        ) : null}
        <p className="mt-2 text-sm text-ink-soft" data-testid="wiki-inbox-totals">
          {t('inbox.totals', {
            pending: data.totals.pending,
            reprocess: data.totals.reprocess,
            inProgress: data.totals.inProgress,
            processed: data.totals.processed,
            skipped: data.totals.skipped,
          })}
        </p>

        {pendingItems.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">{t('inbox.empty')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line/60" data-testid="wiki-inbox-items">
            {pendingItems.map((item) => (
              <li
                key={item.documentId}
                className={`flex flex-wrap items-center gap-2 py-2 text-sm ${item.stale ? 'bg-amber-50' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{item.filename}</span>
                <StatusBadge status={item.status} claimedBy={item.claimedBy} />
                {item.stale ? <Badge tone="warning">{t('inbox.stale')}</Badge> : null}
                {item.partlyWritten && !item.reprocess ? <Badge tone="warning">{t('inbox.partlyWritten')}</Badge> : null}
                <span className="text-xs text-ink-faint">
                  {item.submittedBy.kind === 'agent'
                    ? t('inbox.byAgent', { name: item.submittedBy.name ?? '—' })
                    : item.submittedBy.name ?? '—'}{' '}
                  · {item.status === 'reprocess' && item.reprocess
                    ? t('inbox.reprocess.requestedAt', { when: formatWhen(item.reprocess.requestedAt, locale) })
                    : t('inbox.waitingSince', { when: formatWhen(item.submittedAt, locale) })}
                </span>
                {data.canManage && item.reprocess ? (
                  <button
                    type="button"
                    disabled={busyId === item.documentId}
                    data-testid="wiki-reprocess-cancel"
                    title={t('inbox.reprocess.cancelHelp')}
                    onClick={async () => {
                      setBusyId(item.documentId)
                      setError(null)
                      setNotice(null)
                      const res = await cancelWikiReprocessAction({ connectorId, documentId: item.documentId })
                      setBusyId(null)
                      if (!res.success) setError(t(`errors.${errorKey(res.error)}`))
                      await reload()
                    }}
                    className="text-xs text-coral-deep disabled:opacity-50"
                  >
                    {t('inbox.reprocess.cancel')}
                  </button>
                ) : null}
                {data.canManage && !item.reprocess ? (
                  <button
                    type="button"
                    disabled={busyId === item.documentId}
                    onClick={async () => {
                      setBusyId(item.documentId)
                      const res = await skipWikiInboxItemAction({ connectorId, documentId: item.documentId })
                      setBusyId(null)
                      if (!res.success) setError(t(`errors.${errorKey(res.error)}`))
                      await reload()
                    }}
                    className="text-xs text-coral-deep disabled:opacity-50"
                  >
                    {t('inbox.skip')}
                  </button>
                ) : null}
                {item.reprocess ? <ReprocessNote reprocess={item.reprocess} /> : null}
                {item.partlyWritten ? (
                  <div className="w-full text-xs text-ink-faint" data-testid="wiki-inbox-partly-written">
                    <p>
                      {item.reprocess
                        ? t('inbox.reprocess.existingPages', { count: item.partlyWritten.pageCount })
                        : t('inbox.partlyWrittenPages', { count: item.partlyWritten.pageCount })}
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {item.partlyWritten.pages.map((page) => (
                        <li key={page.path}>
                          <Link href={wikiHref(connectorId, { page: page.path })} className="text-coral-deep hover:underline">
                            {page.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {doneItems.length ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-soft">{t('inbox.doneList', { count: doneItems.length })}</summary>
            <ul className="mt-2 divide-y divide-line/60">
              {doneItems.map((item) => (
                <li key={item.documentId} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{item.filename}</span>
                  <StatusBadge status={item.status} claimedBy={null} />
                  {item.reprocess?.outcome === 'unchanged' ? (
                    <Badge tone="neutral">{t('inbox.reprocess.unchanged')}</Badge>
                  ) : item.reprocess && item.status === 'processed' ? (
                    <Badge tone="neutral">{t('inbox.reprocess.done')}</Badge>
                  ) : null}
                  <span className="text-xs text-ink-faint">{formatWhen(item.submittedAt, locale)}</span>
                  {data.canManage ? (
                    <button
                      type="button"
                      data-testid="wiki-reprocess-open"
                      onClick={() => setReprocessFormId(reprocessFormId === item.documentId ? null : item.documentId)}
                      className="text-xs text-coral-deep"
                    >
                      {t('inbox.reprocess.action')}
                    </button>
                  ) : null}
                  {item.reprocess ? <ReprocessNote reprocess={item.reprocess} /> : null}
                  {reprocessFormId === item.documentId ? (
                    <ReprocessForm
                      connectorId={connectorId}
                      documentId={item.documentId}
                      batchId={item.batchId}
                      batchTotal={data.batches.find((batch) => batch.batchId === item.batchId)?.total ?? 0}
                      onClose={() => setReprocessFormId(null)}
                      onDone={async (message) => {
                        setReprocessFormId(null)
                        setNotice(message)
                        setError(null)
                        await reload()
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
    </div>
  )
}

function ReprocessNote({ reprocess }: { reprocess: NonNullable<WikiInboxData['items'][number]['reprocess']> }) {
  const t = useTranslations('ControlPlane.wiki')
  return (
    <p className="w-full text-xs text-ink-soft" data-testid="wiki-reprocess-reason">
      {t('inbox.reprocess.reasonLine', {
        name:
          reprocess.requestedBy.kind === 'agent'
            ? t('inbox.byAgentName', { name: reprocess.requestedBy.name ?? '—' })
            : reprocess.requestedBy.name ?? '—',
        reason: reprocess.reason,
      })}
    </p>
  )
}

function ReprocessForm({
  connectorId,
  documentId,
  batchId,
  batchTotal,
  onClose,
  onDone,
}: {
  connectorId: string
  documentId: string
  batchId: string | null
  batchTotal: number
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const t = useTranslations('ControlPlane.wiki')
  const [reason, setReason] = useState('')
  const [wholeBatch, setWholeBatch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setFormError(null)
    const res = await requestWikiReprocessAction({
      connectorId,
      reason,
      ...(wholeBatch && batchId ? { batchId } : { documentId }),
    })
    setBusy(false)
    if (!res.success) {
      setFormError(t(`errors.${errorKey(res.error)}`))
      return
    }
    const { marked, waitingForApproval, alreadyInInbox } = res.data
    await onDone(t('inbox.reprocess.result', { marked, waitingForApproval, alreadyInInbox }))
  }

  return (
    <div className="mt-1 w-full space-y-2 rounded-lg border border-line p-3" data-testid="wiki-reprocess-form">
      <p className="text-xs text-ink-soft">{t('inbox.reprocess.explain')}</p>
      <label className="block text-xs font-medium text-ink">
        {t('inbox.reprocess.reasonLabel')}
        <textarea
          value={reason}
          maxLength={1000}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('inbox.reprocess.reasonPlaceholder')}
          data-testid="wiki-reprocess-reason-input"
          className="mt-1 w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm font-normal"
        />
      </label>
      {batchId && batchTotal > 1 ? (
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input type="checkbox" checked={wholeBatch} onChange={(event) => setWholeBatch(event.target.checked)} />
          {t('inbox.reprocess.wholeBatch', { count: batchTotal })}
        </label>
      ) : null}
      {formError ? <p className="text-xs text-coral-deep">{formError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || reason.trim().length === 0}
          onClick={() => void submit()}
          data-testid="wiki-reprocess-submit"
          className="rounded-lg bg-coral px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {t('inbox.reprocess.submit')}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-xs">
          {t('inbox.reprocess.close')}
        </button>
      </div>
    </div>
  )
}

function BatchBar({ batch, label }: { batch: WikiInboxData['batches'][number]; label: string }) {
  const t = useTranslations('ControlPlane.wiki')
  const finished = batch.processed + batch.skipped
  const pct = batch.total ? Math.round((finished / batch.total) * 100) : 0
  return (
    <div data-testid="wiki-batch-bar">
      <p className="mb-1 text-xs text-ink-faint">{label}</p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-sage" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-sm text-ink">
        {t('inbox.batchLine', { done: finished, total: batch.total, pending: batch.pending, reprocess: batch.reprocess, inProgress: batch.inProgress })}
      </p>
    </div>
  )
}

function StatusBadge({ status, claimedBy }: { status: WikiInboxData['items'][number]['status']; claimedBy: string | null }) {
  const t = useTranslations('ControlPlane.wiki')
  if (status === 'in_progress') {
    return <Badge tone="warning">{claimedBy ? t('inbox.status.inProgressBy', { name: claimedBy }) : t('inbox.status.in_progress')}</Badge>
  }
  return <Badge tone={status === 'processed' ? 'success' : 'neutral'}>{t(`inbox.status.${status}`)}</Badge>
}
