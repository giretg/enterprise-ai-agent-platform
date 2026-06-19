'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const DEFAULT_MAX_HEIGHT_PX = 192

export function ExpandableContent({
  children,
  maxHeight = DEFAULT_MAX_HEIGHT_PX,
  expandLabel = 'Teljes méret',
  collapseLabel = 'Összecsuk',
}: {
  children: ReactNode
  maxHeight?: number
  expandLabel?: string
  collapseLabel?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)

  const measure = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    setCanExpand(el.scrollHeight > maxHeight)
  }, [maxHeight])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure, children])

  return (
    <div>
      <div className="relative">
        <div
          ref={contentRef}
          className={expanded ? undefined : 'overflow-hidden'}
          style={expanded ? undefined : { maxHeight }}
        >
          {children}
        </div>
        {!expanded && canExpand && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
            aria-hidden
          />
        )}
      </div>
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-coral/30 hover:bg-coral/5 hover:text-ink"
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      )}
    </div>
  )
}
