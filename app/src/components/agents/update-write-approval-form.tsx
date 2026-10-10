'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  listApproverCandidates,
  updateAgentWriteApprovalModes,
} from '@/app/actions/platform'
import type { WriteApprovalMode } from '@/lib/write-approval-modes'

type Candidate = { id: string; name: string; email: string; role: string | null }

type Modes = {
  memory: WriteApprovalMode
  httpApi: WriteApprovalMode
  gmail: WriteApprovalMode
  drive: WriteApprovalMode
}

const ROWS: Array<{
  key: keyof Modes
  title: string
  hint: string
}> = [
  { key: 'memory', title: 'Memória', hint: 'Tények, fókusz, napló.' },
  { key: 'httpApi', title: 'Céges API', hint: 'CRM és más REST írás.' },
  { key: 'gmail', title: 'Gmail', hint: 'Küldés, piszkozat, címke, kuka.' },
  { key: 'drive', title: 'Drive és táblázat', hint: 'Fájl, mappa, cella. A kimeneti mappa ettől függetlenül mehet.' },
]

function modeLabel(mode: WriteApprovalMode): string {
  return mode === 'approval' ? 'Jóváhagyás kell' : 'Azonnal ír'
}

export function UpdateWriteApprovalForm({
  agentId,
  memoryWriteMode,
  httpApiWriteMode,
  gmailWriteMode,
  driveWriteMode,
  approverUserId,
  canEdit = true,
}: {
  agentId: string
  memoryWriteMode: WriteApprovalMode
  httpApiWriteMode: WriteApprovalMode
  gmailWriteMode: WriteApprovalMode
  driveWriteMode: WriteApprovalMode
  approverUserId: string | null
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [modes, setModes] = useState<Modes>({
    memory: memoryWriteMode,
    httpApi: httpApiWriteMode,
    gmail: gmailWriteMode,
    drive: driveWriteMode,
  })
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [approver, setApprover] = useState(approverUserId ?? '')

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync when agent props refresh after save
    setModes({
      memory: memoryWriteMode,
      httpApi: httpApiWriteMode,
      gmail: gmailWriteMode,
      drive: driveWriteMode,
    })
    setApprover(approverUserId ?? '')
  }, [memoryWriteMode, httpApiWriteMode, gmailWriteMode, driveWriteMode, approverUserId])

  useEffect(() => {
    if (!canEdit) return
    let live = true
    void listApproverCandidates().then((res) => {
      if (live && res.success) setCandidates(res.data.users)
    })
    return () => {
      live = false
    }
  }, [canEdit])

  const needsApprover = Object.values(modes).some((mode) => mode === 'approval')

  if (!canEdit) {
    return (
      <div className="space-y-3 text-sm text-ink-soft">
        <ul className="space-y-1">
          {ROWS.map((row) => (
            <li key={row.key}>
              <span className="font-medium text-ink">{row.title}</span>
              {' — '}
              {modeLabel(modes[row.key])}
            </li>
          ))}
        </ul>
        {needsApprover && approverUserId ? (
          <p>
            Megnevezett jóváhagyó:{' '}
            {candidates?.find((c) => c.id === approverUserId)?.name ?? '…'}
          </p>
        ) : null}
      </div>
    )
  }

  function toggle(key: keyof Modes, on: boolean) {
    setModes((current) => ({ ...current, [key]: on ? 'approval' : 'direct' }))
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentWriteApprovalModes({
            agentId,
            memoryWriteMode: modes.memory,
            httpApiWriteMode: modes.httpApi,
            gmailWriteMode: modes.gmail,
            driveWriteMode: modes.drive,
            approverUserId: needsApprover ? approver || null : approverUserId,
          })
          if (!res.success) {
            setError(res.error)
            return
          }
          setDone('Mentve.')
          router.refresh()
        })
      }}
    >
      <p className="text-sm text-ink-soft">
        Bekapcsolva az agent javasol, egy ember elfogadja. Kapcsold ki, ha a kliens még nem tudja a
        chatben jóváhagyni — az írás akkor azonnal lefut, naplóval. A betanított szabályt ez nem
        nyitja ki.
      </p>
      <ul className="space-y-2">
        {ROWS.map((row) => {
          const on = modes[row.key] === 'approval'
          return (
            <li key={row.key}>
              <label className="flex items-start gap-3 rounded-lg border border-line bg-paper px-3 py-3">
                <input
                  type="checkbox"
                  role="switch"
                  className="mt-1 h-4 w-4 accent-coral"
                  checked={on}
                  onChange={(event) => toggle(row.key, event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-ink">{row.title}</span>
                  <span className="block text-xs text-ink-soft">
                    {row.hint} {modeLabel(on ? 'approval' : 'direct')}.
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      {needsApprover ? (
        <div className="space-y-2 rounded-lg border border-line/60 bg-paper/80 px-3 py-3">
          <label className="block text-sm text-ink-soft">
            Ki hagyja jóvá ezeket az írásokat
            <select
              className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink"
              value={approver}
              onChange={(event) => setApprover(event.target.value)}
              disabled={pending || candidates === null}
            >
              <option value="">Nincs megnevezett — általános sor</option>
              {(candidates ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.email} ({c.role})
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p>
      )}
      <button
        type="submit"
        disabled={pending || (needsApprover && candidates === null)}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés…' : 'Mentés'}
      </button>
    </form>
  )
}
