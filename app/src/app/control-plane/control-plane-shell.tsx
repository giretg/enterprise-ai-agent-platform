'use client'

import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'
import { ControlPlaneHeaderExtras } from '@/components/active-runs/control-plane-header-extras'
import { AgentChatSessionHost } from '@/components/agents/agent-chat-session-host'

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
        headerExtra={<ControlPlaneHeaderExtras />}
      >
        {children}
      </AppShell>
      <AgentChatSessionHost />
    </>
  )
}
