'use client'

import { TenantSwitcher } from '@/components/tenant/tenant-switcher'
import { ActiveRunsPanel } from '@/components/active-runs/active-runs-panel'

/** Control-plane fejléc: tenant switcher + aktív futások badge. */
export function ControlPlaneHeaderExtras() {
  return (
    <div className="flex items-center gap-2">
      <ActiveRunsPanel />
      <TenantSwitcher />
    </div>
  )
}
