'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  createWikiTagAction,
  deleteWikiTagAction,
  previewWikiRevertAction,
  revertWikiAction,
} from '@/app/actions/knowledge-wiki'
import { errorKey } from './knowledge-bases-list'
import { wikiHref } from './wiki-format'

type RevertTarget = { kind: 'changeset'; seq: number } | { kind: 'page'; path: string; version: number }
type Preview = { pageCount: number; pages: string[]; conflicts: Array<{ path: string; reason: string }> }

/**
 * #978 §5.2: visszaállítás megerősítő ablakkal („3 oldal változik vissza.
 * [Előnézet] [Visszaállítás]”). Ütközésnél (D8) semmi nem íródik: megnevezzük
 * az ütköző oldalakat, és oldalanként felajánljuk a visszaállítást.
 */
export function WikiRevertButton({
  connectorId,
  target,
  label,
  previewHref,
}: {
  connectorId: string
  target: RevertTarget
  label?: string
  previewHref?: string
}) {
  const t = useTranslations('ControlPlane.wiki.history')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  const open = () =>
    start(async () => {
      setError(null)
      const res = await previewWikiRevertAction({ connectorId, target })
      if (!res.success) {
        setError(tw(`errors.${errorKey(res.error)}`))
        return
      }
      setPreview(res.data)
    })

  const confirm = () =>
    start(async () => {
      setError(null)
      const res = await revertWikiAction({ connectorId, target })
      if (!res.success) {
        setError(tw(`errors.${errorKey(res.error)}`))
        return
      }
      if (!res.data.ok) {
        setPreview((current) => ({
          pageCount: current?.pageCount ?? 0,
          pages: current?.pages ?? [],
          conflicts: res.data.ok ? [] : res.data.conflicts,
        }))
        setError(t(revertErrorKey(res.data.ok ? '' : res.data.code)))
        return
      }
      setDone(res.data.seq)
      setPreview(null)
      router.refresh()
    })

  if (done !== null) {
    return (
      <span className="text-xs text-sage" data-testid="wiki-revert-done">
        {t('revert.done', { seq: done })}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={open}
        disabled={pending}
        data-testid="wiki-revert-start"
        className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:border-coral/60 disabled:opacity-50"
      >
        {label ?? (target.kind === 'page' ? t('revert.pageButton') : t('revert.changeButton'))}
      </button>
      {error && !preview ? <span className="mt-1 text-xs text-coral-deep">{error}</span> : null}
      {preview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('revert.dialogTitle')}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPreview(null)
          }}
        >
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-card p-5 shadow-xl" data-testid="wiki-revert-dialog">
            <h3 className="font-display text-lg font-semibold">{t('revert.dialogTitle')}</h3>
            <p className="text-sm text-ink">
              {target.kind === 'page'
                ? t('revert.pageBody', { path: target.path, version: target.version })
                : t('revert.changeBody', { count: preview.pageCount, seq: target.seq })}
            </p>
            <p className="text-xs text-ink-soft">{t('revert.newVersionNote')}</p>
            {preview.pages.length > 1 ? (
              <ul className="max-h-40 overflow-auto rounded-lg bg-paper/60 px-3 py-2 text-xs text-ink-soft">
                {preview.pages.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            ) : null}
            {preview.conflicts.length ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="wiki-revert-conflicts">
                <p className="font-medium">{t('revert.conflictTitle')}</p>
                <ul className="mt-1 space-y-1">
                  {preview.conflicts.map((row) => (
                    <li key={row.path}>
                      <a href={wikiHref(connectorId, { page: row.path })} className="text-coral-deep hover:underline">
                        {row.path}
                      </a>{' '}
                      — {t(conflictReasonKey(row.reason))}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">{t('revert.conflictHelp')}</p>
              </div>
            ) : null}
            {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              {previewHref ? (
                <a href={previewHref} className="rounded-md border border-line px-3 py-1.5 text-sm">
                  {t('revert.preview')}
                </a>
              ) : null}
              <button type="button" onClick={() => setPreview(null)} className="rounded-md border border-line px-3 py-1.5 text-sm">
                {tw('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending || preview.conflicts.length > 0}
                data-testid="wiki-revert-confirm"
                className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {pending ? t('revert.working') : t('revert.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  )
}

function revertErrorKey(code: string) {
  if (code === 'conflict') return 'revert.errors.conflict' as const
  if (code === 'version_erased') return 'revert.errors.version_erased' as const
  if (code === 'previous_version_pruned') return 'revert.errors.previous_version_pruned' as const
  if (code === 'changeset_not_revertible') return 'revert.errors.changeset_not_revertible' as const
  if (code === 'already_current') return 'revert.errors.already_current' as const
  return 'revert.errors.generic' as const
}

function conflictReasonKey(reason: string) {
  if (reason === 'version_erased') return 'revert.reasons.version_erased' as const
  if (reason === 'previous_version_pruned') return 'revert.reasons.previous_version_pruned' as const
  if (reason === 'page_missing') return 'revert.reasons.page_missing' as const
  return 'revert.reasons.changed_since' as const
}

/** §5.5 „Állapot elnevezése…” egy sorszámra. */
export function WikiTagForm({ connectorId, seq }: { connectorId: string; seq: number }) {
  const t = useTranslations('ControlPlane.wiki.history')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="wiki-tag-start"
        className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:border-coral/60"
      >
        {t('tags.nameState')}
      </button>
    )
  }
  return (
    <form
      className="mt-2 flex w-full flex-wrap items-end gap-2 rounded-lg border border-line/70 bg-paper/60 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        start(async () => {
          setError(null)
          const res = await createWikiTagAction({ connectorId, seq, name, note: note || undefined })
          if (!res.success) {
            setError(res.error === 'invalid_args' ? t('tags.nameTaken') : tw(`errors.${errorKey(res.error)}`))
            return
          }
          setOpen(false)
          setName('')
          setNote('')
          router.refresh()
        })
      }}
    >
      <label className="text-xs">
        <span className="mb-0.5 block text-ink-soft">{t('tags.name')}</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('tags.namePlaceholder')}
          data-testid="wiki-tag-name"
          className="rounded-md border border-line/70 px-2 py-1 text-sm"
          maxLength={120}
          required
        />
      </label>
      <label className="text-xs">
        <span className="mb-0.5 block text-ink-soft">{t('tags.note')}</span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-md border border-line/70 px-2 py-1 text-sm"
          maxLength={500}
        />
      </label>
      <button
        type="submit"
        disabled={pending || !name.trim()}
        data-testid="wiki-tag-save"
        className="rounded-md bg-ink px-2 py-1 text-xs text-white disabled:opacity-50"
      >
        {tw('common.save')}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-line px-2 py-1 text-xs">
        {tw('common.cancel')}
      </button>
      <p className="w-full text-xs text-ink-faint">{t('tags.help')}</p>
      {error ? <p className="w-full text-xs text-coral-deep">{error}</p> : null}
    </form>
  )
}

export function WikiTagDeleteButton({ connectorId, tagId, name }: { connectorId: string; tagId: string; name: string }) {
  const t = useTranslations('ControlPlane.wiki.history')
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      title={t('tags.delete', { name })}
      aria-label={t('tags.delete', { name })}
      onClick={() => {
        if (!window.confirm(t('tags.deleteConfirm', { name }))) return
        start(async () => {
          await deleteWikiTagAction({ connectorId, tagId })
          router.refresh()
        })
      }}
      className="ml-1 text-ink-faint hover:text-coral-deep disabled:opacity-50"
    >
      ×
    </button>
  )
}
