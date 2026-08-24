'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import {
  closeControlPlanePanelByKey,
  restoreControlPlanePanel,
  useControlPlaneDockedPanelKeys,
} from '@/lib/control-plane-panel-store'
import { panelDefForKey } from '@/lib/control-plane-panels'

export function ControlPlanePanelDockHost() {
  const pathname = usePathname()
  const dockedKeys = useControlPlaneDockedPanelKeys()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  if (!mounted || dockedKeys.length === 0) return null

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[205] flex justify-center p-3 sm:p-4"
      role="toolbar"
      aria-label="Tálcán lévő panelek"
    >
      <div className="pointer-events-auto flex max-w-[min(100%,72rem)] flex-wrap items-stretch justify-center gap-2">
        {dockedKeys.map((key) => {
          const def = panelDefForKey(key)
          const title = def?.title ?? key
          const eyebrow = def?.eyebrow ?? 'Panel'
          return (
            <div
              key={key}
              className="flex max-w-[min(100%,20rem)] items-center gap-2 rounded-2xl border border-line bg-card px-2.5 py-2 shadow-2xl sm:gap-3 sm:px-3 sm:py-2.5"
            >
              <button
                type="button"
                onClick={() => restoreControlPlanePanel(key)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl text-left transition-colors hover:bg-night-2/60 sm:gap-3"
                title={`${title} visszaállítása`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-coral/12 text-sm font-semibold text-coral">
                  ◫
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    {eyebrow}
                  </p>
                  <p className="truncate font-display text-sm font-semibold text-ink">{title}</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => restoreControlPlanePanel(key)}
                className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
                aria-label={`${title} visszaállítása`}
                title="Visszaállítás"
              >
                ▢
              </button>
              <button
                type="button"
                onClick={() => closeControlPlanePanelByKey(key, pathname)}
                className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
                aria-label={`${title} bezárása`}
                title="Bezárás"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
