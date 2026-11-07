'use client'

import Link from 'next/link'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import type { WikiSearchHitView, WikiSearchResult } from '@/domain/knowledge-base/wiki-console-service'
import type { KbSnippet } from '@/lib/kb-text-match'
import { wikiHref } from './wiki-format'
import { readWikiSearchState, writeWikiSearchState } from './wiki-search-state'

const DEBOUNCE_MS = 250
const SLOW_MS = 300
const TIMEOUT_MS = 15_000
const MIN_CHARS = 2
const MAX_CHARS = 200

const subscribeNever = () => () => {}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function Snippet({ snippet }: { snippet: KbSnippet }) {
  const parts: React.ReactNode[] = []
  let at = 0
  snippet.ranges.forEach(([start, end]) => {
    parts.push(snippet.text.slice(at, start))
    parts.push(
      <mark key={start} className="rounded-sm bg-lime/70 text-ink">
        {snippet.text.slice(start, end)}
      </mark>,
    )
    at = end
  })
  parts.push(snippet.text.slice(at))
  return <p className="mt-0.5 line-clamp-2 break-words text-sm text-ink-soft">{parts}</p>
}

/** #1136 §7: kereső gomb és modal a wiki fölött; a találat ugyanabban a nézetben nyílik meg. */
export function WikiSearch({ connectorId, linkQuery }: { connectorId: string; linkQuery?: Record<string, string> }) {
  const t = useTranslations('ControlPlane.wiki.search')
  const baseId = useId()
  const isMac = useSyncExternalStore(
    subscribeNever,
    () => /mac|iphone|ipad/i.test(navigator.userAgent),
    () => false,
  )

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** A lista, és amire érkezett: ha a `resultQuery` eltér a mezőtől, a lista elavult. */
  const [view, setView] = useState<{ result: WikiSearchResult | null; resultQuery: string; active: number }>({
    result: null,
    resultQuery: '',
    active: 0,
  })
  const { result, resultQuery, active } = view
  const [failed, setFailed] = useState(false)
  const [slow, setSlow] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const fabRef = useRef<HTMLButtonElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Újranyitáskor ezt a sort kell kijelölni, ha a friss listában is szerepel. */
  const selectPathRef = useRef<string | null>(null)

  const cancelPending = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = null
    requestRef.current?.abort()
  }, [])

  const runSearch = useCallback(
    async (text: string) => {
      cancelPending()
      const trimmed = text.trim()
      setFailed(false)
      if (trimmed.length < MIN_CHARS) {
        setView({ result: null, resultQuery: '', active: 0 })
        setSlow(false)
        return
      }
      const controller = new AbortController()
      requestRef.current = controller
      const slowTimer = setTimeout(() => setSlow(true), SLOW_MS)
      try {
        const response = await fetch(`/api/control-plane/knowledge/${connectorId}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: trimmed }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const data = (await response.json()) as WikiSearchResult
        if (controller.signal.aborted) return
        const reopened = selectPathRef.current
        selectPathRef.current = null
        setView((previous) => {
          // Ugyanarra a szövegre a néző addigi léptetése marad: a ⌘K, ↓, Enter nem várhat a válaszra.
          const wanted = previous.resultQuery === trimmed ? previous.result?.hits[previous.active]?.path : reopened
          const index = wanted ? data.hits.findIndex((hit) => hit.path === wanted) : -1
          return { result: data, resultQuery: trimmed, active: Math.max(index, 0) }
        })
      } catch {
        // Az újabb kérés miatt megszakított válasz nem hiba; a lejárt kérés igen.
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        clearTimeout(slowTimer)
        if (requestRef.current === controller) setSlow(false)
      }
    },
    [cancelPending, connectorId],
  )

  const openDialog = useCallback(() => {
    if (open) {
      inputRef.current?.select()
      return
    }
    const saved = readWikiSearchState(connectorId)
    if (saved) {
      selectPathRef.current = saved.opened ?? null
      setView((previous) => {
        if (previous.resultQuery !== saved.query.trim()) return previous
        const index = previous.result?.hits.findIndex((hit) => hit.path === saved.opened) ?? -1
        return index >= 0 ? { ...previous, active: index } : previous
      })
      setQuery(saved.query)
      void runSearch(saved.query)
    }
    setOpen(true)
  }, [connectorId, open, runSearch])

  const closeDialog = useCallback(
    (restoreFocus = true) => {
      cancelPending()
      setSlow(false)
      setOpen(false)
      if (query.trim()) {
        const previous = readWikiSearchState(connectorId)
        writeWikiSearchState(connectorId, { query, opened: previous?.query === query ? previous.opened : undefined })
      }
      if (restoreFocus) {
        const target = buttonRef.current?.offsetParent ? buttonRef.current : fabRef.current
        target?.focus({ preventScroll: true })
      }
    },
    [cancelPending, connectorId, query],
  )

  // Csak ott él, ahol a gomb látszik: a komponens ott van a fán.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      openDialog()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openDialog])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = overflow
    }
  }, [open])

  useEffect(() => cancelPending, [cancelPending])

  useEffect(() => {
    if (!open) return
    document.getElementById(`${baseId}-hit-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, baseId, open, result])

  const hits = result?.hits ?? []
  const trimmed = query.trim()
  const isCurrent = trimmed === resultQuery

  const onInputChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void runSearch(value), DEBOUNCE_MS)
  }

  const onHitClick = (event: ReactMouseEvent, hit: WikiSearchHitView) => {
    // Ctrl-, ⌘- és Shift-kattintás új lapon nyit: a modal és a lista marad.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    writeWikiSearchState(connectorId, { query, opened: hit.path })
    selectPathRef.current = null
    closeDialog()
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (hits.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setView((previous) => ({ ...previous, active: Math.min(Math.max(previous.active + step, 0), hits.length - 1) }))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!isCurrent) {
        void runSearch(query)
        return
      }
      // Igazi kattintás a linkre: a Vissza gomb így menti el a görgetési helyet.
      document.getElementById(`${baseId}-hit-${active}`)?.querySelector('a')?.click()
    }
  }

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeDialog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])')
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const firstPartial = hits.findIndex((hit) => !hit.full)
  const listId = `${baseId}-list`
  const showList = hits.length > 0 && trimmed.length >= MIN_CHARS

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openDialog}
        data-testid="wiki-search-open"
        className="hidden w-full items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-left text-sm text-ink-soft shadow-sm hover:border-ink/30 hover:text-ink lg:flex"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('button')}</span>
        <kbd className="shrink-0 rounded border border-line bg-night-2 px-1.5 text-xs font-sans text-ink-faint">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <button
        ref={fabRef}
        type="button"
        onClick={openDialog}
        aria-label={t('button')}
        title={t('button')}
        data-testid="wiki-search-fab"
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-ink text-white shadow-lg lg:hidden"
      >
        <SearchIcon className="h-5 w-5" />
      </button>

      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[300] flex items-start justify-center bg-ink/40 backdrop-blur-[2px] sm:p-4 sm:pt-[10vh]"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeDialog()
              }}
            >
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={t('title')}
                onKeyDown={onDialogKeyDown}
                data-testid="wiki-search-dialog"
                className="flex h-[100dvh] w-full flex-col bg-card shadow-2xl sm:h-auto sm:max-h-[75vh] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-line"
              >
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <SearchIcon className="h-5 w-5 shrink-0 text-ink-faint" />
                  <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-label={t('inputLabel')}
                    aria-expanded={showList}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={showList ? `${baseId}-hit-${active}` : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_CHARS}
                    value={query}
                    placeholder={t('placeholder')}
                    onChange={(event) => onInputChange(event.target.value)}
                    onKeyDown={onInputKeyDown}
                    data-testid="wiki-search-input"
                    className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
                  />
                  {query ? (
                    <button
                      type="button"
                      aria-label={t('clear')}
                      title={t('clear')}
                      onClick={() => {
                        setQuery('')
                        void runSearch('')
                        inputRef.current?.focus()
                      }}
                      data-testid="wiki-search-clear"
                      className="rounded p-1 text-ink-faint hover:text-ink"
                    >
                      ✕
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => closeDialog()}
                    aria-label={t('close')}
                    data-testid="wiki-search-close"
                    className="rounded border border-line px-1.5 py-0.5 text-xs text-ink-soft hover:text-ink"
                  >
                    Esc
                  </button>
                </div>

                <div className="min-h-[2rem] px-4 pt-2 text-xs text-ink-faint">
                  <p role="status" aria-live="polite" data-testid="wiki-search-count">
                    {slow ? t('loading') : result && showList ? t('count', { count: result.total }) : ''}
                  </p>
                </div>

                <div className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${slow ? 'opacity-70' : ''}`} aria-busy={slow}>
                  {failed ? (
                    <div className="px-2 py-6 text-center text-sm text-ink-soft" data-testid="wiki-search-error">
                      <p>{t('error')}</p>
                      <button
                        type="button"
                        onClick={() => void runSearch(query)}
                        data-testid="wiki-search-retry"
                        className="mt-2 rounded-lg border border-line px-3 py-1 text-sm font-medium text-ink hover:border-ink/30"
                      >
                        {t('retry')}
                      </button>
                    </div>
                  ) : trimmed.length < MIN_CHARS ? (
                    <p className="px-2 py-6 text-center text-sm text-ink-soft" data-testid="wiki-search-hint">{t('hint')}</p>
                  ) : result && isCurrent && hits.length === 0 ? (
                    <p className="break-words px-2 py-6 text-center text-sm text-ink-soft" data-testid="wiki-search-empty">
                      {t('empty', { query: trimmed })}
                    </p>
                  ) : null}

                  {showList && !failed ? (
                    <ul id={listId} role="listbox" aria-label={t('resultsLabel')} data-testid="wiki-search-results">
                      {hits.map((hit, index) => (
                        <li key={hit.path} role="presentation">
                          {index === firstPartial ? (
                            <p
                              role="presentation"
                              data-testid="wiki-search-partial-heading"
                              className="mt-3 px-2 pb-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint"
                            >
                              {t('partialHeading', { count: hits.length - firstPartial })}
                            </p>
                          ) : null}
                          <div
                            id={`${baseId}-hit-${index}`}
                            role="option"
                            aria-selected={index === active}
                            onMouseMove={() => setView((previous) => (previous.active === index ? previous : { ...previous, active: index }))}
                            data-testid="wiki-search-hit"
                            className={`rounded-lg border-l-2 ${index === active ? 'border-coral bg-coral/5' : 'border-transparent'}`}
                          >
                            <Link
                              href={wikiHref(connectorId, { ...linkQuery, page: hit.path })}
                              tabIndex={-1}
                              onClick={(event) => onHitClick(event, hit)}
                              className="block px-3 py-2"
                            >
                              <p className="truncate text-sm font-medium text-ink">{hit.title}</p>
                              <p className="truncate text-xs text-ink-faint">
                                {hit.category ? `${hit.category} · ` : ''}
                                {hit.full ? t('occurrences', { count: hit.occurrences }) : t('missing', { words: hit.missing.join(', ') })}
                              </p>
                              <Snippet snippet={hit.snippet} />
                            </Link>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {showList && !failed && result && result.total > hits.length ? (
                    <p className="px-3 py-2 text-xs text-ink-faint" data-testid="wiki-search-more">
                      {t('more', { count: result.total - hits.length })}
                    </p>
                  ) : null}
                </div>

                <p className="hidden border-t border-line px-4 py-2 text-xs text-ink-faint sm:block">{t('footer')}</p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
