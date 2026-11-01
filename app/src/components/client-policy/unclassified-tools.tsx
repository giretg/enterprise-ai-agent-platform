'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { asTranslate } from '@/i18n/translate'
import { TOOL_CLASSES, type ToolClass } from '@/domain/client-policy/tool-catalog'

export type UnclassifiedToolRow = { tool: string; attempts: number; lastSeenAt: string; hermesVersion: string | null }

/** Ismeretlen eszközhöz a híd és a céges MCP nem választható: az előbbi nem döntési pont, az utóbbi névminta. */
const PICKABLE = TOOL_CLASSES.filter((c) => !['passthrough', 'mcp', 'denied'].includes(c))

export const toolClassLabelKey = (cls: string) => `toolClasses.${cls.replaceAll(':', '_')}`

export function UnclassifiedTools({ rows }: { rows: UnclassifiedToolRow[] }) {
  const t = asTranslate(useTranslations('ClientPolicy'))
  const router = useRouter()
  const [choice, setChoice] = useState<Record<string, ToolClass>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  async function classify(tool: string, cls: ToolClass) {
    setPending(tool)
    setMessage('')
    try {
      const response = await fetch('/api/client-policy/admin/tool-catalog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, class: cls }),
      })
      if (!response.ok) setMessage(t('saveFailed'))
      else router.refresh()
    } catch { setMessage(t('saveFailed')) }
    finally { setPending(null) }
  }

  if (rows.length === 0) return <p className="rounded-xl border border-line p-4 text-sm text-ink-soft">{t('unclassifiedEmpty')}</p>
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">{t('unclassifiedHelp')}</p>
      <ul className="space-y-3">
        {rows.map((row) => {
          const selected = choice[row.tool] ?? 'capability:local_files:read'
          return (
            <li key={row.tool} className="rounded-xl border border-line p-3">
              <p className="break-all font-mono text-sm font-semibold">{row.tool}</p>
              <p className="mt-1 text-xs text-ink-soft">
                {t('unclassifiedSeen', { attempts: row.attempts, when: new Date(row.lastSeenAt).toLocaleString() })}
                {row.hermesVersion ? ` · Hermes ${row.hermesVersion}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`cls-${row.tool}`}>{t('unclassifiedPick')}</label>
                <select id={`cls-${row.tool}`} value={selected} disabled={pending !== null}
                  onChange={(e) => setChoice({ ...choice, [row.tool]: e.target.value as ToolClass })}
                  className="rounded-lg border border-line bg-card px-2 py-2 text-sm">
                  {PICKABLE.map((cls) => <option key={cls} value={cls}>{t(toolClassLabelKey(cls))}</option>)}
                </select>
                <button type="button" disabled={pending !== null} onClick={() => classify(row.tool, selected)}
                  className="rounded-full bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{t('unclassifiedClassify')}</button>
                <button type="button" disabled={pending !== null} onClick={() => classify(row.tool, 'denied')}
                  className="rounded-full border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">{t('unclassifiedDeny')}</button>
              </div>
            </li>
          )
        })}
      </ul>
      <p role="status" aria-live="polite" className="text-sm text-coral-deep">{message}</p>
    </div>
  )
}
