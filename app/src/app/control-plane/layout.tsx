'use client'

import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'

const navItems: NavEntry[] = [
  { href: '/control-plane', label: 'Dashboard', exact: true },
  { href: '/control-plane/board', label: 'Board' },
  { href: '/control-plane/agents', label: 'Agents' },
  { href: '/control-plane/apps', label: 'App Registry' },
  { href: '/control-plane/playbooks', label: 'Playbookok' },
  { href: '/control-plane/processes', label: 'Folyamatok' },
  {
    label: 'Üzemeltetés',
    children: [
      { href: '/control-plane/scheduled-tasks', label: 'Ütemezés' },
      { href: '/control-plane/monitors', label: 'Monitorok' },
      { href: '/control-plane/training', label: 'Tanítás' },
    ],
  },
  {
    label: 'Adminisztráció',
    children: [
      { href: '/control-plane/connectors', label: 'Fiókok' },
      { href: '/control-plane/provisioning', label: 'Provisioning' },
      { href: '/control-plane/iam', label: 'IAM' },
      { href: '/control-plane/governance', label: 'Governance' },
      { href: '/control-plane/system', label: 'Rendszer' },
      { href: '/control-plane/audit', label: 'Audit' },
    ],
  },
]

export default function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <AppShell
      appName="A Pince"
      appSubtitle="Control Plane · OSTOROSBOR"
      navItems={navItems}
      accentColor="slate"
      pathname={pathname}
      switchLink={{ href: '/sandbox', label: '→ Sandbox' }}
    >
      {children}
    </AppShell>
  )
}
