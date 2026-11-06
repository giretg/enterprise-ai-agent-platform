'use client'

import { useEffect, useState, useTransition } from 'react'
import { listVoiceTranscriptsAction, readVoiceTranscriptAction } from '@/app/actions/voice'
import type { VoiceTranscriptLine } from '@/components/agents/voice-call-events'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Spinner } from '@/components/ui/spinner'
import type { VoiceTranscriptSummary } from '@/domain/ai-audit/ai-audit-service'

type Listing = { items: VoiceTranscriptSummary[]; hasMore: boolean }
type Reader = { id: string; lines: VoiceTranscriptLine[] } | { id: string; error: string }

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Budapest' })
}

function formatOffset(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function summaryText(meta: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof meta.seconds === 'number') parts.push(`${formatOffset(meta.seconds)} perc`)
  if (typeof meta.backendCalls === 'number') parts.push(`${meta.backendCalls} utánanézés`)
  if (typeof meta.avgBackendWaitMs === 'number') {
    parts.push(`átlag ${(meta.avgBackendWaitMs / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} mp várakozás`)
  }
  return parts.join(' · ')
}

function missingTextReason(meta: Record<string, unknown>): string {
  return meta.contentDropped === 'too_large'
    ? 'A szöveg túl hosszú volt a mentéshez, csak a mérések maradtak meg.'
    : 'A szervezet naplózási beállítása miatt csak a mérések maradtak meg.'
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="m5 7.5 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Transcript({ lines, agentName, truncated }: { lines: VoiceTranscriptLine[]; agentName: string; truncated: boolean }) {
  return (
    <div className="max-h-[60vh] space-y-3 overflow-y-auto px-2 pb-4 pt-1 text-sm">
      {truncated ? <p className="text-center text-xs text-ink-faint">A hosszú beszélgetés eleje nem fért a mentésbe, a vége látszik.</p> : null}
      {lines.map((line, index) => {
        const at = typeof line.atSeconds === 'number' ? formatOffset(line.atSeconds) : null
        if (line.role === 'tool') {
          return (
            <p key={index} className="text-center text-xs text-ink-faint">
              {at ? `${at} · ` : ''}
              {line.text}
            </p>
          )
        }
        const caller = line.role === 'user'
        return (
          <div key={index} className={caller ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
            <p className="mb-1 text-xs text-ink-faint">
              {caller ? 'Hívó' : agentName}
              {at ? ` · ${at}` : ''}
            </p>
            <p className={`whitespace-pre-wrap break-words text-ink ${caller ? 'max-w-[85%] rounded-2xl bg-night-2 px-3.5 py-2' : 'max-w-[92%]'}`}>{line.text}</p>
          </div>
        )
      })}
    </div>
  )
}

/** Hang-beszélgetések utólagos elolvasása minőségellenőrzéshez. */
export function VoiceTranscriptsPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [reader, setReader] = useState<Reader | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    void listVoiceTranscriptsAction({ agentId }).then((res) => {
      if (!active) return
      if (res.success) setListing(res.data)
      else setListError(res.error)
    })
    return () => {
      active = false
    }
  }, [agentId])

  function toggle(id: string) {
    if (reader?.id === id) {
      setReader(null)
      return
    }
    setLoadingId(id)
    startTransition(async () => {
      const res = await readVoiceTranscriptAction({ agentId, id })
      setReader(res.success ? { id, lines: res.data.lines as VoiceTranscriptLine[] } : { id, error: res.error })
      setLoadingId(null)
    })
  }

  if (listError) return <p className="text-sm text-coral-deep">{listError}</p>
  if (!listing) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-soft">
        <Spinner size="sm" /> Betöltés…
      </p>
    )
  }
  if (listing.items.length === 0) {
    return <p className="text-sm text-ink-soft">Még nincs elmentett beszélgetés. Az első hangos beszélgetés vége után itt jelenik meg.</p>
  }

  return (
    <div>
      {/* A súgó jobbra nyílik: a sor elején telefonon is kifér a képernyőre. */}
      <p className="mb-2 flex items-center gap-1.5 pr-2 text-xs text-ink-soft">
        <HelpHint>Itt olvashatod vissza, mi hangzott el a munkatárs hangos beszélgetéseiben. A szöveg személyes adatot tartalmazhat. A beszélgetések alapból 90 nap után törlődnek.</HelpHint>
        Minden megnyitás a naplóba kerül.
      </p>
      <ul className="divide-y divide-line">
        {listing.items.map((item) => {
          const open = reader?.id === item.id
          return (
            <li key={item.id}>
              {item.hasContent ? (
                <button
                  type="button"
                  aria-expanded={open}
                  disabled={pending}
                  onClick={() => toggle(item.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-night-2 disabled:cursor-wait"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{formatDate(item.createdAt)}</span>
                    <span className="block text-xs text-ink-soft">{summaryText(item.meta)}</span>
                  </span>
                  {loadingId === item.id ? <Spinner size="sm" /> : <Chevron open={open} />}
                </button>
              ) : (
                <div className="px-2 py-3">
                  <p className="text-sm font-medium text-ink-soft">{formatDate(item.createdAt)}</p>
                  <p className="text-xs text-ink-faint">{[summaryText(item.meta), missingTextReason(item.meta)].filter(Boolean).join(' · ')}</p>
                </div>
              )}
              {open && reader ? (
                'error' in reader ? (
                  <p className="px-2 pb-4 text-sm text-coral-deep">{reader.error}</p>
                ) : (
                  <Transcript lines={reader.lines} agentName={agentName} truncated={item.meta.truncated === true} />
                )
              ) : null}
            </li>
          )
        })}
      </ul>
      {listing.hasMore ? <p className="px-2 pt-3 text-xs text-ink-faint">A legutóbbi {listing.items.length} beszélgetés látszik.</p> : null}
    </div>
  )
}
