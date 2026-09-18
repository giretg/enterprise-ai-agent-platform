'use client'

import { Suspense, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'
import { AgentRail, AgentRailMobileToggle } from '@/components/agents/agent-rail'
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
 * teljes shell + agent-sáv.
 */
export function ControlPlaneRoot({
  embedFromServer,
  navItems = [],
  canCreateAgent = false,
  children,
}: {
  embedFromServer: boolean
  navItems?: NavEntry[]
  canCreateAgent?: boolean
  canCreateTicket?: boolean
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
  return (
    <ControlPlaneShell navItems={navItems} canCreateAgent={canCreateAgent}>
      {children}
    </ControlPlaneShell>
  )
}

function ControlPlaneBody({
  children,
  canCreateAgent,
}: {
  children: React.ReactNode
  canCreateAgent: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <AgentRail canCreateAgent={canCreateAgent} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-auto px-4 py-6 sm:px-6">{children}</div>
      </div>
    </div>
  )
}

export function ControlPlaneShell({
  navItems,
  children,
  canCreateAgent = false,
}: {
  navItems: NavEntry[]
  children: React.ReactNode
  canCreateAgent?: boolean
  canCreateTicket?: boolean
}) {
  const pathname = usePathname()

  return (
    <>
      <Suspense fallback={null}>
        <AppShell
          appName="E-AI"
          appSubtitle="Control Plane"
          navItems={navItems}
          accentColor="slate"
          pathname={pathname}
          navMode="modal"
          layout="rail"
          headerExtra={
            <div className="flex items-center gap-2">
              <AgentRailMobileToggle />
            </div>
          }
        >
          <ControlPlaneBody canCreateAgent={canCreateAgent}>{children}</ControlPlaneBody>
        </AppShell>
      </Suspense>
      <Suspense fallback={null}>
        <RouteModalHost />
      </Suspense>
      <ControlPlanePanelDockHost />
    </>
  )
}
