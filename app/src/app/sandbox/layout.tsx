'use client'

import { usePathname } from 'next/navigation'
import { AppShell } from '@/components/ui/shell'

const navItems = [{ href: '/sandbox', label: 'Munkatér', exact: true }]

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <AppShell
      appName="Sandbox"
      appSubtitle="Könyvelő munkatér · Data Plane"
      navItems={navItems}
      accentColor="teal"
      pathname={pathname}
      switchLink={{ href: '/control-plane', label: '→ Control Plane' }}
    >
      {children}
    </AppShell>
  )
}
