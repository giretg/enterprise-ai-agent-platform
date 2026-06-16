'use client'

import { usePathname } from 'next/navigation'
import { AppShell } from '@/components/ui/shell'

const navItems = [
  { href: '/control-plane', label: 'Dashboard', exact: true },
  { href: '/control-plane/board', label: 'Board' },
  { href: '/control-plane/agents', label: 'Agents' },
  { href: '/control-plane/training', label: 'Tanítás' },
  { href: '/control-plane/iam', label: 'IAM' },
  { href: '/control-plane/governance', label: 'Governance' },
  { href: '/control-plane/audit', label: 'Audit' },
]

export default function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <AppShell
      appName="A Pince"
      appSubtitle="Control Plane · Ostoros-Novaj"
      navItems={navItems}
      accentColor="slate"
      pathname={pathname}
      switchLink={{ href: '/sandbox', label: '→ Sandbox' }}
    >
      {children}
    </AppShell>
  )
}
