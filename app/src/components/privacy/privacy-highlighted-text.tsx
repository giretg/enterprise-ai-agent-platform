'use client'

import type { ReactNode } from 'react'
import type { PrivacyEntityMarker } from '@/domain/privacy/privacy-observability'
import { markerHighlightClass, markerTooltipText } from '@/domain/privacy/privacy-observability'

export function PrivacyHighlightedText({
  text,
  markers,
  showAdminAlias = false,
  className,
}: {
  text: string
  markers: readonly PrivacyEntityMarker[]
  showAdminAlias?: boolean
  className?: string
}) {
  if (!text) return null
  if (markers.length === 0) {
    return <span className={className}>{text}</span>
  }

  const sorted = [...markers].sort((a, b) => a.start - b.start)
  const parts: ReactNode[] = []
  let cursor = 0
  for (const marker of sorted) {
    if (marker.start > cursor) {
      parts.push(<span key={`plain-${cursor}`}>{text.slice(cursor, marker.start)}</span>)
    }
    parts.push(
      <span
        key={`mark-${marker.start}-${marker.end}`}
        className={`rounded-sm px-0.5 ${markerHighlightClass(marker.status)}`}
        title={markerTooltipText(marker)}
      >
        {text.slice(marker.start, marker.end)}
        {showAdminAlias && marker.previewAlias ? (
          <span className="ml-1 font-mono text-[10px] text-accent">{marker.previewAlias}</span>
        ) : null}
      </span>,
    )
    cursor = marker.end
  }
  if (cursor < text.length) {
    parts.push(<span key={`tail-${cursor}`}>{text.slice(cursor)}</span>)
  }

  return <span className={className}>{parts}</span>
}
