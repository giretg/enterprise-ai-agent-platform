'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  listWikiInboxAction,
  skipWikiInboxItemAction,
  uploadWikiInboxFileAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'
import { formatWhen } from './wiki-format'

/** D12: fájlonként legfeljebb 10 MB (a szerver is ellenőrzi). */
const MAX_FILE_BYTES = 10 * 1024 * 1024
const POLL_MS = 10_000
const PARALLEL_UPLOADS = 3

export type WikiInboxData = {
  canManage: boolean
  canContribute: boolean
  totals: { pending: number; inProgress: number; processed: number; skipped: number }
  batches: Array<{
    batchId: string
    pending: number
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
    status: 'pending' | 'in_progress' | 'processed' | 'skipped'
    submittedBy: { kind: 'agent' | 'human'; name: string | null }
    claimedBy: string | null
    submittedAt: string
    batchId: string | null
    stale: boolean
  }>
}

type UploadState = {
  total: number
  done: number
  duplicates: string[]
  tooLarge: string[]
  failed: string[]
}

export function WikiInboxPanel({ connectorId, initial }: { connectorId: string; initial: WikiInboxData }) {
  const t = useTranslations('ControlPlane.wiki')
  const locale = useLocale()
  const [data, setData] = useState(initial)
  const [upload, setUpload] = useState<UploadState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    const res = await listWikiInboxAction({ connectorId })
    if (res.success) setData(res.data)
  }, [connectorId])

  // A köteg-állás magától frissül, amíg van váró vagy feldolgozás alatti tétel.
  const active = data.totals.pending + data.totals.inProgress > 0 || upload !== null
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [active, reload])

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setError(null)
    const tooLarge = files.filter((file) => file.size > MAX_FILE_BYTES).map((file) => file.name)
    const queue = files.filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES)
    const failed = files.filter((file) => file.size === 0).map((file) => file.name)
    const state: UploadState = { total: files.length, done: tooLarge.length + failed.length, duplicates: [], tooLarge, failed }
    setUpload({ ...state })
    const batchId = crypto.randomUUID()
    let next = 0
    async function worker() {
      while (next < queue.length) {
        const seq = next++
        const file = queue[seq]
        const form = new FormData()
        form.set('connectorId', connectorId)
        form.set('batchId', batchId)
        form.set('batchSeq', String(seq))
        form.set('file', file)
        try {
          const res = await uploadWikiInboxFileAction(form)
          if (!res.success) state.failed.push(file.name)
          else if (res.data.status === 'duplicate') state.duplicates.push(file.name)
        } catch {
          state.failed.push(file.name)
        } finally {
          state.done++
          setUpload({ ...state, duplicates: [...state.duplicates], failed: [...state.failed] })
        }
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
  const pendingItems = data.items.filter((item) => item.status === 'pending' || item.status === 'in_progress')
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
                : t('inbox.uploaded', { total: upload.total - upload.tooLarge.length - upload.failed.length - upload.duplicates.length })}
            </p>
            {upload.duplicates.length ? (
              <p className="text-xs text-amber-800">{t('inbox.duplicates', { count: upload.duplicates.length, names: upload.duplicates.slice(0, 5).join(', ') })}</p>
            ) : null}
            {upload.tooLarge.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.tooLarge', { count: upload.tooLarge.length, names: upload.tooLarge.slice(0, 5).join(', ') })}</p>
            ) : null}
            {upload.failed.length ? (
              <p className="text-xs text-coral-deep">{t('inbox.failed', { count: upload.failed.length, names: upload.failed.slice(0, 5).join(', ') })}</p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
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
                <span className="text-xs text-ink-faint">
                  {item.submittedBy.kind === 'agent'
                    ? t('inbox.byAgent', { name: item.submittedBy.name ?? '—' })
                    : item.submittedBy.name ?? '—'}{' '}
                  · {t('inbox.waitingSince', { when: formatWhen(item.submittedAt, locale) })}
                </span>
                {data.canManage ? (
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
                  <span className="text-xs text-ink-faint">{formatWhen(item.submittedAt, locale)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
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
        {t('inbox.batchLine', { done: finished, total: batch.total, pending: batch.pending, inProgress: batch.inProgress })}
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
