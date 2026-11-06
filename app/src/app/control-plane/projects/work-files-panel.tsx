'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLocale, useTranslations } from 'next-intl'
import {
  deleteWorkFileAction,
  exportWorkFileAction,
  listWorkFilesAction,
  readWorkFileAction,
  saveWorkFileAction,
  type WorkFileListItem,
} from '@/app/actions/project-work'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { asTranslate } from '@/i18n/translate'
import { isSafeMarkdownImageSrc } from '@/lib/markdown-url-policy'
import { workFilePagePath } from '@/lib/work-file-link'
import {
  WORK_FILE_SORT_KEYS,
  fileBaseName,
  fileExtension,
  fileFolder,
  filterWorkFiles,
  formatFileSize,
  groupByFolder,
  isMarkdownFile,
  sortWorkFiles,
  splitFrontmatter,
  type WorkFileSortKey,
} from '@/lib/work-file-list'
import { projectWorkErrorLabel } from './labels'
import {
  projectWorkFieldClass,
  projectWorkGhostBtnClass,
  projectWorkPrimaryBtnClass,
} from './project-memory-panel'

type Translate = ReturnType<typeof asTranslate>
type Mode = 'read' | 'edit'
type FileMeta = { createdAt: string; updatedAt: string; byteSize: number }

const SORT_LABEL_KEYS: Record<WorkFileSortKey, string> = {
  path: 'sortPath',
  name: 'sortName',
  updated_desc: 'sortUpdatedDesc',
  updated_asc: 'sortUpdatedAsc',
  created_desc: 'sortCreatedDesc',
  created_asc: 'sortCreatedAsc',
  size_desc: 'sortSizeDesc',
}

const MARKDOWN_CLASS =
  'work-file-markdown space-y-3 break-words text-[15px] leading-relaxed text-ink ' +
  '[&_a]:text-coral-deep [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-soft ' +
  '[&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1 [&_code]:text-[0.9em] ' +
  '[&_h1]:font-display [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold ' +
  '[&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:font-semibold ' +
  '[&_hr]:my-4 [&_hr]:border-line [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc ' +
  '[&_.contains-task-list]:list-none [&_.task-list-item]:ml-0! ' +
  '[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-ink/5 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
  '[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line/70 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top ' +
  '[&_th]:border [&_th]:border-line/70 [&_th]:bg-paper [&_th]:px-2 [&_th]:py-1 [&_th]:text-left'

function dateFormatter(locale: string, withTime: boolean) {
  return new Intl.DateTimeFormat(locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
}

function formatDate(fmt: Intl.DateTimeFormat, iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : fmt.format(date)
}

function downloadBlob(base64: string, filename: string, mime: string) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ───────────────────────── formázott markdown ───────────────────────── */

function WorkFileMarkdown({ source, t }: { source: string; t: Translate }) {
  const { front, body } = splitFrontmatter(source)
  return (
    <div className={MARKDOWN_CLASS}>
      {front ? (
        <pre className="text-xs text-ink-soft">
          <code>{front}</code>
        </pre>
      ) : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const external = !!href && /^https?:\/\//i.test(href)
            return (
              <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {children}
              </a>
            )
          },
          // Külső kép nem töltődik be magától (nyomkövetés / adatkiszivárgás): csak a leírása látszik.
          img({ src, alt }) {
            const url = typeof src === 'string' ? src : undefined
            // eslint-disable-next-line @next/next/no-img-element -- csak same-origin / data: kép jut ide
            if (isSafeMarkdownImageSrc(url)) return <img src={url} alt={alt ?? ''} className="max-w-full" />
            return <span className="text-ink-soft">{t('imageHidden', { alt: alt ?? '' })}</span>
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table>{children}</table>
              </div>
            )
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}

/* ───────────────────────── letöltés menü ───────────────────────── */

function DownloadMenu({
  path,
  busy,
  onPick,
  t,
}: {
  path: string
  busy: boolean
  onPick: (format: 'original' | 'html' | 'docx') => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const ext = fileExtension(path) || '.txt'
  const items: Array<{ id: 'docx' | 'html' | 'original'; label: string }> = [
    { id: 'docx', label: t('downloadWord') },
    { id: 'html', label: t('downloadHtml') },
    { id: 'original', label: t('downloadOriginal', { ext }) },
  ]
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('downloadHint')}
        onClick={() => setOpen((v) => !v)}
        className={projectWorkGhostBtnClass}
      >
        {t('download')} ▾
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-ink/10 bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(item.id)
              }}
              className="block w-full px-4 py-2 text-left text-sm text-ink hover:bg-night/30"
            >
              {item.label}
            </button>
          ))}
          <p className="border-t border-ink/10 px-4 py-2 text-xs text-ink-soft">{t('downloadHint')}</p>
        </div>
      ) : null}
    </div>
  )
}

/* ───────────────────────── a megnyitott fájl ───────────────────────── */

type ViewerProps = {
  path: string
  meta: FileMeta | null
  draft: string
  dirty: boolean
  mode: Mode
  canEdit: boolean
  saving: boolean
  downloading: boolean
  large: boolean
  locale: string
  t: Translate
  onMode: (mode: Mode) => void
  onDraft: (value: string) => void
  onSave: () => void
  onDelete: () => void
  onDownload: (format: 'original' | 'html' | 'docx') => void
  onCopyLink: () => void
  onOpenLarge?: () => void
  onCloseLarge?: () => void
}

function WorkFileViewer(props: ViewerProps) {
  const { path, meta, draft, dirty, mode, canEdit, saving, large, locale, t } = props
  const markdown = isMarkdownFile(path)
  const day = useMemo(() => dateFormatter(locale, true), [locale])
  const folder = fileFolder(path)
  return (
    <div
      className={
        large
          ? 'flex h-full min-h-0 flex-col'
          : 'space-y-3 rounded-xl border border-ink/10 bg-white/60 p-4 shadow-sm'
      }
    >
      <div className={large ? 'shrink-0 space-y-1 border-b border-line px-5 py-4' : 'space-y-1'}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3
              className="break-words font-display text-lg font-semibold leading-snug text-ink [overflow-wrap:anywhere]"
              title={path}
            >
              {fileBaseName(path)}
            </h3>
            {folder ? <p className="truncate text-xs text-ink-soft">{folder}/</p> : null}
          </div>
          {large && props.onCloseLarge ? (
            <button
              type="button"
              onClick={props.onCloseLarge}
              aria-label={t('closeLarge')}
              title={t('closeLarge')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-night-2 hover:text-ink"
            >
              ✕
            </button>
          ) : null}
        </div>
        {meta ? (
          <p className="text-xs text-ink-soft">
            {t('metaCreated')}: {formatDate(day, meta.createdAt)} · {t('metaUpdated')}: {formatDate(day, meta.updatedAt)} ·{' '}
            {t('metaSize')}: {formatFileSize(meta.byteSize)}
          </p>
        ) : null}
      </div>

      <div
        className={
          large
            ? 'flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2'
            : 'flex flex-wrap items-center gap-2'
        }
      >
        {canEdit ? (
          <div className="flex gap-1 rounded-full border border-line/60 bg-panel/40 p-1" role="tablist" title={t('modeHint')}>
            {(['read', 'edit'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                onClick={() => props.onMode(id)}
                className={`rounded-full px-3 py-1 text-sm transition-colors ${
                  mode === id ? 'bg-coral/15 font-medium text-coral-deep' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {id === 'read' ? t('modeRead') : t('modeEdit')}
              </button>
            ))}
          </div>
        ) : null}
        {mode === 'edit' && canEdit ? (
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={props.onSave}
            className={projectWorkPrimaryBtnClass}
          >
            {saving ? t('saving') : t('save')}
          </button>
        ) : null}
        {dirty ? <span className="text-xs font-medium text-coral-deep">{t('unsaved')}</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!large && props.onOpenLarge ? (
            <button type="button" onClick={props.onOpenLarge} className={projectWorkGhostBtnClass}>
              {t('openLarge')}
            </button>
          ) : null}
          <button type="button" onClick={props.onCopyLink} title={t('linkHint')} className={projectWorkGhostBtnClass}>
            {t('copyLink')}
          </button>
          <DownloadMenu path={path} busy={props.downloading} onPick={props.onDownload} t={t} />
        </div>
      </div>

      <div className={large ? 'min-h-0 flex-1 overflow-y-auto px-5 py-4' : ''}>
        {mode === 'edit' && canEdit ? (
          <textarea
            className={`${projectWorkFieldClass} font-mono ${large ? 'h-full min-h-[24rem] resize-none' : ''}`}
            rows={large ? undefined : 18}
            value={draft}
            onChange={(e) => props.onDraft(e.target.value)}
            spellCheck={false}
            aria-label={path}
          />
        ) : !draft.trim() ? (
          <p className="text-sm text-ink-soft">{t('emptyFile')}</p>
        ) : markdown ? (
          <div className={large ? 'mx-auto max-w-3xl' : 'max-h-[70vh] overflow-y-auto pr-1'}>
            <WorkFileMarkdown source={draft} t={t} />
          </div>
        ) : (
          <pre
            className={`whitespace-pre-wrap break-words rounded-lg bg-ink/5 p-3 font-mono text-sm text-ink ${
              large ? '' : 'max-h-[70vh] overflow-y-auto'
            }`}
          >
            {draft}
          </pre>
        )}
      </div>

      {canEdit ? (
        <div className={large ? 'flex shrink-0 flex-wrap gap-2 border-t border-line px-5 py-3' : 'flex flex-wrap gap-2'}>
          <button
            type="button"
            onClick={props.onDelete}
            className="rounded-full px-4 py-1.5 text-sm text-coral-deep hover:bg-coral/10"
          >
            {t('delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ───────────────────────── nagy ablak ───────────────────────── */

function LargeViewDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])
  useEffect(() => {
    if (!mounted) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted, onClose])
  if (!mounted) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-line bg-card shadow-xl"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

/* ───────────────────────── a Munkafájlok fül ───────────────────────── */

export function WorkFilesPanel({
  projectKey,
  canEdit,
  initialFile,
}: {
  projectKey: string
  canEdit: boolean
  /** Mélylinkből (pl. az agent által adott linkről) érkező fájl: betöltés után megnyílik. */
  initialFile?: string | null
}) {
  const t = asTranslate(useTranslations('ControlPlane.projects'))
  const locale = useLocale()
  const day = useMemo(() => dateFormatter(locale, false), [locale])

  const [files, setFiles] = useState<WorkFileListItem[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WorkFileSortKey>('path')

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [meta, setMeta] = useState<FileMeta | null>(null)
  const [mode, setMode] = useState<Mode>('read')
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [largeOpen, setLargeOpen] = useState(false)

  const [showNewFile, setShowNewFile] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newFileContent, setNewFileContent] = useState('')

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const deepLinkHandled = useRef(false)
  const viewerRef = useRef<HTMLDivElement>(null)
  const dirty = selectedPath !== null && draft !== saved

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setFilesLoading(true)
      setError(null)
      const res = await listWorkFilesAction({ projectKey })
      if (cancelled) return
      setFilesLoading(false)
      if (!res.success) {
        setError(projectWorkErrorLabel(res.error, (key) => t(key)))
        return
      }
      setFiles(res.data.files)
      if (initialFile && !deepLinkHandled.current) {
        deepLinkHandled.current = true
        void openFile(initialFile)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- csak projektváltásra töltünk újra
  }, [projectKey])

  const visible = useMemo(() => sortWorkFiles(filterWorkFiles(files, query), sort), [files, query, sort])
  const groups = useMemo(() => (sort === 'path' ? groupByFolder(visible) : null), [visible, sort])

  function syncUrl(path: string | null) {
    try {
      window.history.replaceState(null, '', path ? workFilePagePath(projectKey, path) : '/control-plane/projects')
    } catch {
      /* a cím frissítése csak kényelmi funkció */
    }
  }

  async function openFile(path: string) {
    setShowNewFile(false)
    setSelectedPath(path)
    setMode('read')
    setFileLoading(true)
    setError(null)
    const res = await readWorkFileAction({ projectKey, path })
    setFileLoading(false)
    if (!res.success) {
      setSelectedPath(null)
      setError(projectWorkErrorLabel(res.error, (key) => t(key)))
      return
    }
    setSaved(res.data.content)
    setDraft(res.data.content)
    setMeta({
      createdAt: res.data.createdAt,
      updatedAt: res.data.updatedAt,
      byteSize: new TextEncoder().encode(res.data.content).length,
    })
    syncUrl(path)
    // Keskeny képernyőn a lista a fájl fölött van: a megnyitott fájlhoz görgetünk.
    if (window.matchMedia('(max-width: 767px)').matches) {
      requestAnimationFrame(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!dirty || !selectedPath) return true
    return confirmDialog({
      title: t('discardTitle'),
      description: t('discardBody', { path: selectedPath }),
      confirmLabel: t('discardConfirm'),
      cancelLabel: t('cancel'),
      tone: 'danger',
    })
  }

  async function onSelect(path: string) {
    if (path === selectedPath) return
    if (!(await confirmDiscard())) return
    await openFile(path)
  }

  async function refreshList() {
    const listed = await listWorkFilesAction({ projectKey })
    if (listed.success) setFiles(listed.data.files)
    return listed.success ? listed.data.files : null
  }

  async function onSave(path: string, content: string, isNew: boolean) {
    if (!path.trim()) return
    setSaving(true)
    setError(null)
    setNotice(null)
    const res = await saveWorkFileAction({ projectKey, path: path.trim(), content })
    setSaving(false)
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error, (key) => t(key)))
      return
    }
    const list = await refreshList()
    const row = list?.find((f) => f.path === res.data.path)
    setSelectedPath(res.data.path)
    setSaved(content)
    setDraft(content)
    if (row) setMeta({ createdAt: row.createdAt, updatedAt: row.updatedAt, byteSize: row.byteSize })
    if (isNew) {
      setShowNewFile(false)
      setNewPath('')
      setNewFileContent('')
      setMode('read')
    }
    syncUrl(res.data.path)
    setNotice(t('fileSaved'))
  }

  async function onDelete(path: string) {
    const confirmed = await confirmDialog({
      title: t('deleteFileTitle'),
      description: t('deleteFileConfirm', { path }),
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    setError(null)
    const res = await deleteWorkFileAction({ projectKey, path })
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error, (key) => t(key)))
      return
    }
    setFiles((current) => current.filter((f) => f.path !== path))
    if (selectedPath === path) {
      setSelectedPath(null)
      setSaved('')
      setDraft('')
      setMeta(null)
      setLargeOpen(false)
      syncUrl(null)
    }
    setNotice(t('fileDeleted'))
  }

  async function onDownload(format: 'original' | 'html' | 'docx') {
    if (!selectedPath) return
    setDownloading(true)
    setError(null)
    setNotice(null)
    try {
      const res = await exportWorkFileAction({ projectKey, path: selectedPath, format })
      if (!res.success) {
        setError(projectWorkErrorLabel(res.error, (key) => t(key)))
        return
      }
      downloadBlob(res.data.base64, res.data.filename, res.data.mime)
      setNotice(t(dirty ? 'downloadedUnsaved' : 'downloaded', { name: res.data.filename }))
    } catch {
      setError(t('downloadFailed'))
    } finally {
      setDownloading(false)
    }
  }

  async function onCopyLink() {
    if (!selectedPath) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${workFilePagePath(projectKey, selectedPath)}`)
      setNotice(t('linkCopied'))
    } catch {
      setError(t('linkCopyFailed'))
    }
  }

  function startNewFile() {
    void (async () => {
      if (!(await confirmDiscard())) return
      setShowNewFile(true)
      setSelectedPath(null)
      setNewPath('')
      setNewFileContent('')
    })()
  }

  const dateLabel = (file: WorkFileListItem) =>
    sort === 'created_desc' || sort === 'created_asc'
      ? t('fileCreated', { date: formatDate(day, file.createdAt) })
      : t('fileUpdated', { date: formatDate(day, file.updatedAt) })

  const viewerProps: ViewerProps | null = selectedPath
    ? {
        path: selectedPath,
        meta,
        draft,
        dirty,
        mode,
        canEdit,
        saving,
        downloading,
        large: false,
        locale,
        t,
        onMode: setMode,
        onDraft: setDraft,
        onSave: () => void onSave(selectedPath, draft, false),
        onDelete: () => void onDelete(selectedPath),
        onDownload: (format) => void onDownload(format),
        onCopyLink: () => void onCopyLink(),
        onOpenLarge: () => setLargeOpen(true),
      }
    : null

  return (
    <section className="space-y-3" aria-label={t('tabFiles')}>
      <p className="text-sm text-ink-soft">{t('filesHint')}</p>
      {notice ? (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-sm text-sage">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">{error}</p>
      ) : null}

      {canEdit && !showNewFile ? (
        <button type="button" onClick={startNewFile} className={projectWorkPrimaryBtnClass}>
          {t('newFile')}
        </button>
      ) : null}
      {showNewFile ? (
        <div className="space-y-2 rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
          <input
            className={projectWorkFieldClass}
            placeholder={t('filePath')}
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <textarea
            className={projectWorkFieldClass + ' font-mono'}
            rows={8}
            placeholder={t('fileContent')}
            value={newFileContent}
            onChange={(e) => setNewFileContent(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving || !newPath.trim()}
              onClick={() => void onSave(newPath, newFileContent, true)}
              className={projectWorkPrimaryBtnClass}
            >
              {saving ? t('saving') : t('saveFile')}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewFile(false)
                setNewPath('')
                setNewFileContent('')
              }}
              className={projectWorkGhostBtnClass}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="w-full shrink-0 space-y-2 md:w-80">
          <input
            type="search"
            className={projectWorkFieldClass}
            placeholder={t('fileSearch')}
            aria-label={t('fileSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="block text-xs text-ink-soft" title={t('sortHint')}>
            {t('fileSort')}
            <select
              className={projectWorkFieldClass + ' mt-1'}
              value={sort}
              onChange={(e) => setSort(e.target.value as WorkFileSortKey)}
            >
              {WORK_FILE_SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {t(SORT_LABEL_KEYS[key])}
                </option>
              ))}
            </select>
          </label>
          {!filesLoading && files.length > 0 ? (
            <p className="text-xs text-ink-soft">
              {visible.length === files.length
                ? t('fileCount', { count: files.length })
                : t('fileCountFiltered', { shown: visible.length, total: files.length })}
            </p>
          ) : null}

          <div className="space-y-1 md:max-h-[68vh] md:overflow-y-auto md:pr-1">
            {filesLoading ? (
              <p className="text-sm text-ink-soft">{t('loading')}</p>
            ) : files.length === 0 ? (
              <p className="text-sm text-ink-soft">{t('noFiles')}</p>
            ) : visible.length === 0 ? (
              <p className="text-sm text-ink-soft">{t('noFileMatches')}</p>
            ) : (
              (groups ?? [{ folder: null as string | null, files: visible }]).map((group) => (
                <div key={group.folder ?? '__flat__'} className="space-y-1">
                  {groups ? (
                    <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                      {group.folder || t('folderRoot')}
                    </p>
                  ) : null}
                  {group.files.map((file) => {
                    const selected = selectedPath === file.path
                    const folder = fileFolder(file.path)
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => void onSelect(file.path)}
                        title={file.path}
                        aria-current={selected ? 'true' : undefined}
                        className={`block w-full rounded-lg px-3 py-2 text-left transition-colors ${
                          selected ? 'bg-coral/15' : 'hover:bg-night/30'
                        }`}
                      >
                        <span
                          className={`block text-sm font-medium [overflow-wrap:anywhere] ${
                            selected ? 'text-coral-deep' : 'text-ink'
                          }`}
                        >
                          {fileBaseName(file.path)}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-soft">
                          {dateLabel(file)} · {formatFileSize(file.byteSize)}
                        </span>
                        {!groups && folder ? (
                          <span className="block truncate text-xs text-ink-faint">{folder}/</span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 scroll-mt-4" ref={viewerRef}>
          {!viewerProps ? (
            <p className="text-sm text-ink-soft">{t('pickFile')}</p>
          ) : fileLoading ? (
            <p className="text-sm text-ink-soft">{t('loading')}</p>
          ) : (
            <WorkFileViewer {...viewerProps} />
          )}
        </div>
      </div>

      {largeOpen && viewerProps ? (
        <LargeViewDialog title={fileBaseName(viewerProps.path)} onClose={() => setLargeOpen(false)}>
          <WorkFileViewer {...viewerProps} large onCloseLarge={() => setLargeOpen(false)} />
        </LargeViewDialog>
      ) : null}
    </section>
  )
}
