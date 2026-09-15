'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { runAgentDiagnostics, type AgentDiagnosticsResult } from '@/app/actions/agent-diagnostics'
import type { DiagnosticCheck } from '@/domain/agent-diagnostics/agent-diagnostics'
import { Badge, Card } from '@/components/ui/shell'

const TONE = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  unknown: 'neutral',
} as const

const STATUS_LABEL: Record<DiagnosticCheck['status'], string> = {
  ok: 'rendben',
  warn: 'figyelmeztetés',
  fail: 'hiba',
  unknown: 'nem vizsgálható',
}

/**
 * Agent-teszt egy gombnyomásra (admin-only, az oldal csak adminnak rendereli).
 * Az eredmény minden során ott a javításhoz vivő link — ugyanarra a szekcióra,
 * ahol a hiba kézzel is javítható (Eszközök / Kapcsolatok / Skillek).
 */
export function AgentDiagnosticsPanel({ agentId, bare = false }: { agentId: string; bare?: boolean }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AgentDiagnosticsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [includeWriteProbe, setIncludeWriteProbe] = useState(false)

  function run() {
    startTransition(async () => {
      setError(null)
      const res = await runAgentDiagnostics({ agentId, includeLive: true, includeWriteProbe })
      if (res.success) {
        setResult(res.data)
      } else {
        setError(res.error)
      }
    })
  }

  const body = (
    <>
      <p className="mb-4 text-xs text-ink-faint">
        Megnézi, hogy az agent eszközei, skillei és kapcsolatai tényleg működnek-e: van-e
        minden engedélyezett eszköz mögött kapcsolat, elég-e a hozzáférés az íráshoz is,
        és elérhetők-e élőben a rendszerek. Külső levelet soha nem küld.
      </p>
      <label className="mb-4 flex cursor-pointer items-start gap-2 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={includeWriteProbe}
          onChange={(e) => setIncludeWriteProbe(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Írási próba is: piszkozat / mappa létrehozása és azonnali törlése.
          <span className="text-ink-faint">
            {' '}
            Enélkül csak azt látod, hogy az írás elméletileg menne-e.
          </span>
        </span>
      </label>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        aria-busy={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Tesztelés…' : result ? 'Újratesztelés' : 'Agent tesztelése'}
      </button>
      {error && <p role="alert" className="mt-4 text-sm text-coral">{error}</p>}
      {result && (
        <div aria-live="polite" className="mt-5 space-y-6">
          <CheckGroup title="Beállítások" checks={result.static} agentId={agentId} />
          <CheckGroup title="Élő kapcsolatok" checks={result.live} agentId={agentId} />
        </div>
      )}
    </>
  )

  if (bare) return body
  return <Card title="Agent tesztelése">{body}</Card>
}

function CheckGroup({
  title,
  checks,
  agentId,
}: {
  title: string
  checks: DiagnosticCheck[]
  agentId: string
}) {
  if (checks.length === 0) return null
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">{title}</p>
      <ul className="space-y-2">
        {checks.map((check) => (
          <li
            key={check.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-night-2/30 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONE[check.status]}>{STATUS_LABEL[check.status]}</Badge>
                <span className="text-sm font-medium text-ink">{check.label}</span>
              </div>
              <p className="mt-1 text-xs text-ink-soft">{check.detail}</p>
            </div>
            {check.status === 'ok' ? null : (
              <Link
                href={`/control-plane/agents/${agentId}?section=${check.fixSection}`}
                className="shrink-0 rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft hover:text-ink"
              >
                Ugrás a javításhoz →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
