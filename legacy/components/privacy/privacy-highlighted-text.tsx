'use client'

import type { ReactNode } from 'react'
import type {
  PrivacyEntityMarker,
  PrivacyTransformStatus,
} from '@/domain/privacy/privacy-observability'
import { markerTooltipText } from '@/domain/privacy/privacy-observability'

function markerHighlightClass(status: PrivacyTransformStatus): string {
  switch (status) {
    case 'observed':
      return 'bg-honey/25 text-ink border-b border-honey/60'
    case 'applied':
      return 'bg-sage/20 text-ink border-b border-sage/50'
    case 'blocked':
      return 'bg-coral/15 text-ink border-b border-coral/50'
    case 'skipped':
      return 'bg-night-3 text-ink-soft border-b border-line/60'
    default:
      return 'bg-night-3 text-ink-soft'
  }
}

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
