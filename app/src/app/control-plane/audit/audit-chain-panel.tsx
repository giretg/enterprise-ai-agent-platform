'use client'

import { useState, useTransition } from 'react'
import { exportAuditSiem, verifyAuditChain } from '@/app/actions/audit'

export function AuditChainPanel() {
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; checked: number } | { ok: false; checked: number; firstBreakSeq: string } | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [verifying, startVerify] = useTransition()
  const [exporting, startExport] = useTransition()

  function handleVerify() {
    startVerify(async () => {
      const res = await verifyAuditChain()
      if (res.success) {
        setActionError(null)
        setVerifyResult(res.data)
        return
      }
      setVerifyResult(null)
      setActionError(res.error)
    })
  }

  function handleExport() {
    startExport(async () => {
      const res = await exportAuditSiem()
      if (!res.success) {
        setActionError(res.error)
        return
      }
      setActionError(null)
      const blob = new Blob([res.data.content], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.data.filename
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={handleVerify}
        disabled={verifying}
        className="rounded-lg border border-line bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-coral/40 hover:bg-coral/6 disabled:opacity-50"
      >
        {verifying ? 'Ellenőrzés…' : 'Lánc ellenőrzése'}
      </button>

      <button
        onClick={handleExport}
        disabled={exporting}
        className="rounded-lg border border-line bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-honey/40 hover:bg-honey/6 disabled:opacity-50"
      >
        {exporting ? 'Export…' : 'JSONL letöltése'}
      </button>

      {actionError && (
        <p className="w-full rounded-lg border border-coral/35 bg-coral/10 p-3 text-sm text-coral-deep">
          {actionError}
        </p>
      )}
      {verifyResult && (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
            verifyResult.ok ? 'bg-sage/15 text-sage' : 'bg-coral/15 text-coral-deep'
          }`}
        >
          {verifyResult.ok ? (
            <>✓ Lánc ép · {verifyResult.checked} bejegyzés</>
          ) : (
            <>
              ✗ Törés: seq {verifyResult.firstBreakSeq} · {verifyResult.checked} ellenőrizve
            </>
          )}
        </span>
      )}
    </div>
  )
}
