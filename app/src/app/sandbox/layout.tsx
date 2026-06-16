'use client'

import { usePathname } from 'next/navigation'
import { AppShell } from '@/components/ui/shell'

const navItems = [{ href: '/sandbox', label: 'Sandboxok' }]

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <AppShell
      appName="Agent Sandbox"
      appSubtitle="Sandbox · Agent munkaterek"
      navItems={navItems}
      accentColor="teal"
      pathname={pathname}
      switchLink={{ href: '/control-plane', label: '→ Control Plane' }}
    >
      {children}
    </AppShell>
  )
}
