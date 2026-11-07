'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { foldKbText, kbMatchRanges, type KbTextTerm } from '@/lib/kb-text-match'
import { consumeWikiSearchHighlight, WIKI_SEARCH_HIGHLIGHT_EVENT, WIKI_SEARCH_OPEN_EVENT } from './wiki-search-state'

const HIGHLIGHT_ALL = 'wiki-search'
const HIGHLIGHT_CURRENT = 'wiki-search-current'

function clearHighlights() {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(HIGHLIGHT_ALL)
  CSS.highlights.delete(HIGHLIGHT_CURRENT)
}

/** A látható előfordulások dokumentum-sorrendben, a `data-wiki-search-scope` elemekből. */
function findRanges(terms: KbTextTerm[]): Range[] {
  const ranges: Range[] = []
  for (const scope of document.querySelectorAll('[data-wiki-search-scope]')) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? ''
      let previousEnd = -1
      for (const match of kbMatchRanges(foldKbText(text), terms)) {
        if (match.start < previousEnd) {
          // Átfedő szavak (kártya + kártyaelfogadás): egy előfordulás, a hosszabb szó szélességével.
          if (match.end > previousEnd) {
            ranges[ranges.length - 1].setEnd(node, match.end)
            previousEnd = match.end
          }
          continue
        }
        const range = document.createRange()
        range.setStart(node, match.start)
        range.setEnd(node, match.end)
        ranges.push(range)
        previousEnd = match.end
      }
    }
  }
  // Ami nem látszik (pl. rejtett elem), ahhoz nem lehet görgetni.
  return ranges.filter((range) => range.getClientRects().length > 0)
}

function scrollToRange(range: Range) {
  window.scrollBy({ top: range.getBoundingClientRect().top - window.innerHeight / 3 })
}

/**
 * #1136 §7.5: keresésből érkezve kiemeli az oldalon az előfordulásokat, és sávot ad a
 * léptetéshez. A CSS Highlight API nem nyúl a React által kezelt DOM-hoz (D9): ahol nincs,
 * ott nincs kiemelés és sáv, az olvasás ettől nem romlik.
 */
export function WikiSearchHighlight({ connectorId, path }: { connectorId: string; path: string }) {
  const t = useTranslations('ControlPlane.wiki.search.bar')
  const [bar, setBar] = useState<{ query: string; total: number; index: number } | null>(null)
  const rangesRef = useRef<Range[]>([])

  const markCurrent = useCallback((index: number) => {
    const range = rangesRef.current[index]
    if (!range) return
    const current = new Highlight(range)
    current.priority = 1
    CSS.highlights.set(HIGHLIGHT_CURRENT, current)
    scrollToRange(range)
    setBar((previous) => (previous ? { ...previous, index } : previous))
  }, [])

  const apply = useCallback(() => {
    if (typeof Highlight === 'undefined' || !('highlights' in CSS)) return
    const arrival = consumeWikiSearchHighlight(connectorId, path)
    if (arrival) {
      rangesRef.current = findRanges(arrival.terms)
      setBar(rangesRef.current.length ? { query: arrival.query, total: rangesRef.current.length, index: 0 } : null)
      // A következő képkockán: a lapváltás a saját görgetését (a lap tetejére) előbb végzi el.
      requestAnimationFrame(() => markCurrent(0))
    }
    // Érkezés nélkül is újrafest: az effekt újrafutása (Strict Mode) törli a kiemelést, a szavak pedig már elfogytak.
    if (rangesRef.current.length) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...rangesRef.current))
  }, [connectorId, markCurrent, path])

  useEffect(() => {
    apply()
    // Ugyanarra az oldalra mutató találatnál nincs lapváltás, ezért jelzést kapunk.
    window.addEventListener(WIKI_SEARCH_HIGHLIGHT_EVENT, apply)
    return () => {
      window.removeEventListener(WIKI_SEARCH_HIGHLIGHT_EVENT, apply)
      clearHighlights()
    }
  }, [apply])

  if (!bar) return null

  const step = (delta: number) => markCurrent((bar.index + delta + bar.total) % bar.total)
  const iconButton = 'rounded px-2 py-0.5 text-base leading-none text-ink-soft hover:bg-ink/5 hover:text-ink'

  return (
    <div
      data-testid="wiki-search-bar"
      className="sticky top-[calc(var(--app-header-h,0px)+0.5rem)] z-10 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-card px-3 py-1.5 text-sm shadow-sm"
    >
      <p className="min-w-0 flex-1 truncate text-ink-soft" aria-live="polite" data-testid="wiki-search-bar-position">
        {t('position', { query: bar.query, current: bar.index + 1, total: bar.total })}
      </p>
      <button type="button" onClick={() => step(-1)} aria-label={t('previous')} title={t('previous')} data-testid="wiki-search-bar-prev" className={iconButton}>
        ‹
      </button>
      <button type="button" onClick={() => step(1)} aria-label={t('next')} title={t('next')} data-testid="wiki-search-bar-next" className={iconButton}>
        ›
      </button>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(WIKI_SEARCH_OPEN_EVENT))}
        data-testid="wiki-search-bar-results"
        className="rounded px-2 py-0.5 font-medium text-coral-deep hover:bg-coral/5"
      >
        {t('results')}
      </button>
      <button
        type="button"
        onClick={() => {
          clearHighlights()
          rangesRef.current = []
          setBar(null)
        }}
        aria-label={t('clear')}
        title={t('clear')}
        data-testid="wiki-search-bar-clear"
        className={iconButton}
      >
        ✕
      </button>
    </div>
  )
}
