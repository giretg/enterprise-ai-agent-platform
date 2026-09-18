'use client'

import { TenantSwitcher } from '@/components/tenant/tenant-switcher'
import { ActiveRunsPanel } from '@/components/active-runs/active-runs-panel'
import { AutomationModeToggle } from '@/components/automation/automation-mode-toggle'

/** Control-plane fejléc: üresjárat/normál kapcsoló + aktív futások + tenant switcher. */
export function ControlPlaneHeaderExtras() {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <div className="hidden sm:block">
        <AutomationModeToggle />
      </div>
      <ActiveRunsPanel />
      <TenantSwitcher />
    </div>
  )
}
