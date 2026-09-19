'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'
import { TenantSwitcher } from '@/components/tenant/tenant-switcher'
import { ControlPlanePanelDockHost } from '@/components/ui/control-plane-panel-dock'
import { RouteModalHost } from '@/components/ui/route-modal'
import { ControlPlaneEmbedBridge } from '@/lib/control-plane-embed-bridge'

function subscribeNever() {
  return () => {}
}

function readInIframe() {
  return window.parent !== window
}

/**
 * Stabil layout-wrapper: iframe-ben (header-modál) soha ne mountolódjon a
 * teljes shell.
 */
export function ControlPlaneRoot({
  embedFromServer,
  navItems = [],
  children,
}: {
  embedFromServer: boolean
  navItems?: NavEntry[]
  canCreateAgent?: boolean
  children: ReactNode
}) {
  const inIframe = useSyncExternalStore(subscribeNever, readInIframe, () => embedFromServer)
  if (embedFromServer || inIframe) {
    return (
      <ControlPlaneEmbedBridge>
        <div className="min-h-full bg-night px-4 py-6 text-ink sm:px-6">{children}</div>
      </ControlPlaneEmbedBridge>
    )
  }
  return <ControlPlaneShell navItems={navItems}>{children}</ControlPlaneShell>
}

export function ControlPlaneShell({
  navItems,
  children,
}: {
  navItems: NavEntry[]
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <>
      <AppShell
        appName="E-AI"
        appSubtitle="Control Plane"
        navItems={navItems}
        accentColor="slate"
        pathname={pathname}
        navMode="modal"
        headerExtra={<TenantSwitcher />}
      >
        {children}
      </AppShell>
      <RouteModalHost />
      <ControlPlanePanelDockHost />
    </>
  )
}
