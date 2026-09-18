'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  getAutomationModeToggleState,
  resumeAutomationMode,
  setMinimalCostMode,
} from '@/app/actions/platform'
import type { ActionResult } from '@/lib/result'

type ToggleState = { canToggle: boolean; idle: boolean }

/**
 * Fejléc: üresjárat ↔ normál mód kapcsoló (platform-superadmin).
 * Üresjáratban a Scheduler / agent-indítás / monitor ki — a Neon nem ébred magától.
 */
export function AutomationModeToggle() {
  const router = useRouter()
  const [idle, setIdle] = useState<boolean | null>(null)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const applyState = useCallback((res: ActionResult<ToggleState>) => {
    if (!res.success) {
      setVisible(false)
      return
    }
    setVisible(res.data.canToggle)
    setIdle(res.data.idle)
  }, [])

  const refresh = useCallback(async () => {
    applyState(await getAutomationModeToggleState())
  }, [applyState])

  useEffect(() => {
    let cancelled = false
    void getAutomationModeToggleState().then((res) => {
      if (cancelled) return
      applyState(res)
    })
    return () => {
      cancelled = true
    }
  }, [applyState])

  if (!visible || idle === null) return null

  const setMode = (wantIdle: boolean) => {
    if (wantIdle === idle || pending) return
    setError(null)
    startTransition(async () => {
      const res = wantIdle ? await setMinimalCostMode() : await resumeAutomationMode()
      if (!res.success) {
        setError(res.error)
        return
      }
      await refresh()
      router.refresh()
    })
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      <div
        role="group"
        aria-label="Automatizmus mód"
        className="inline-flex items-center rounded-full border border-line bg-card p-0.5 text-[11px] font-semibold tracking-wide"
      >
        <button
          type="button"
          disabled={pending}
          aria-pressed={idle}
          title="Üresjárat: nincs ütemezett Neon-ébresztés"
          onClick={() => setMode(true)}
          className={`rounded-full px-2.5 py-1.5 transition-colors disabled:opacity-50 ${
            idle
              ? 'bg-honey/20 text-honey'
              : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          Üresjárat
        </button>
        <button
          type="button"
          disabled={pending}
          aria-pressed={!idle}
          title="Normál: Scheduler és agent-indítás az előző állapot szerint"
          onClick={() => setMode(false)}
          className={`rounded-full px-2.5 py-1.5 transition-colors disabled:opacity-50 ${
            !idle
              ? 'bg-sage/20 text-sage'
              : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          Normál
        </button>
      </div>
      {error ? (
        <p className="absolute right-0 top-full z-50 mt-1 max-w-[14rem] rounded-lg border border-coral/40 bg-night/95 px-2 py-1 text-[10px] text-coral-deep shadow-lg">
          {error}
        </p>
      ) : null}
    </div>
  )
}
