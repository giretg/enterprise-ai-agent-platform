'use client'

import { useEffect, useState, useTransition } from 'react'
import { listVoiceTranscriptsAction, readVoiceTranscriptAction } from '@/app/actions/voice'
import type { VoiceTranscriptSummary } from '@/domain/ai-audit/ai-audit-service'

type Line = { role?: string; text?: string; atSeconds?: number }

const ROLE_LABEL: Record<string, string> = { user: 'Hívó', assistant: 'Munkatárs' }

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Budapest' })
}

function formatOffset(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function summaryText(meta: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof meta.seconds === 'number') parts.push(`${formatOffset(meta.seconds)} hosszú`)
  if (typeof meta.backendCalls === 'number') parts.push(`${meta.backendCalls} utánanézés`)
  if (typeof meta.avgBackendWaitMs === 'number') parts.push(`átlag ${(meta.avgBackendWaitMs / 1000).toFixed(1)} mp várakozás`)
  return parts.join(', ')
}

/** Hang-beszélgetések utólagos elolvasása minőségellenőrzéshez. */
export function VoiceTranscriptsPanel({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<VoiceTranscriptSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    void listVoiceTranscriptsAction({ agentId }).then((res) => {
      if (!active) return
      if (res.success) setItems(res.data)
      else setError(res.error)
    })
    return () => {
      active = false
    }
  }, [agentId])

  function open(id: string) {
    if (openId === id) {
      setOpenId(null)
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await readVoiceTranscriptAction({ agentId, id })
      if (res.success) {
        setLines(res.data.lines as Line[])
        setOpenId(id)
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-soft">
        Itt olvashatod el, mi hangzott el a hangos beszélgetésekben. A szöveg személyes adatot tartalmazhat, ezért minden megnyitás bekerül a
        naplóba. A beszélgetések alapból 90 nap után törlődnek.
      </p>
      {error ? <p className="text-coral-deep">{error}</p> : null}
      {items === null && !error ? <p className="text-ink-soft">Betöltés…</p> : null}
      {items?.length === 0 ? <p className="text-ink-soft">Még nincs elmentett beszélgetés. Az első hangos beszélgetés vége után itt jelenik meg.</p> : null}
      <ul className="space-y-2">
        {items?.map((item) => (
          <li key={item.id} className="rounded-lg border border-line px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-ink">{formatDate(item.createdAt)}</p>
                <p className="text-xs text-ink-soft">{summaryText(item.meta)}</p>
              </div>
              {item.hasContent ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => open(item.id)}
                  className="rounded-full border border-line px-3 py-1 font-semibold text-ink-soft hover:bg-night-2 disabled:opacity-60"
                >
                  {openId === item.id ? 'Bezárás' : 'Megnyitás'}
                </button>
              ) : (
                <span className="text-xs text-ink-soft">A szervezet naplózási beállítása miatt csak a mérések maradtak meg.</span>
              )}
            </div>
            {openId === item.id ? (
              <div className="mt-3 space-y-1 border-t border-line pt-3">
                {lines.map((line, index) => {
                  const at = typeof line.atSeconds === 'number' ? `${formatOffset(line.atSeconds)} ` : ''
                  return line.role === 'tool' ? (
                    <p key={index} className="text-xs text-ink-soft">
                      {at}
                      {line.text}
                    </p>
                  ) : (
                    <p key={index}>
                      <span className="text-xs text-ink-faint">{at}</span>
                      <span className="font-semibold text-ink">{ROLE_LABEL[line.role ?? ''] ?? 'Ismeretlen'}: </span>
                      <span className="text-ink">{line.text}</span>
                    </p>
                  )
                })}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
