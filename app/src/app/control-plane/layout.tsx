'use client'

import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'
import { TenantSwitcher } from '@/components/tenant/tenant-switcher'

const navItems: NavEntry[] = [
  { href: '/control-plane', label: 'Dashboard', exact: true },
  { href: '/control-plane/board', label: 'Board' },
  {
    label: 'Ágensek',
    children: [
      { href: '/control-plane/agents', label: 'Agents' },
      { href: '/control-plane/behavior-profiles', label: 'Viselkedés-profilok' },
      { href: '/control-plane/apps', label: 'Mini-appok' },
      { href: '/control-plane/sandbox-versions', label: 'Sandbox verziók' },
    ],
  },
  {
    label: 'Automatizálás',
    children: [
      { href: '/control-plane/playbooks', label: 'Playbookok' },
      { href: '/control-plane/step-templates', label: 'Lépés-sablonok' },
      { href: '/control-plane/processes', label: 'Folyamatok' },
    ],
  },
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
      { href: '/control-plane/platform/tenants', label: 'Platform · Tenantok' },
      { href: '/control-plane/platform/iam', label: 'Platform · IAM' },
      { href: '/control-plane/platform/settings', label: 'Platform · Beállítások' },
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
      appName="E-AI"
      appSubtitle="Control Plane"
      navItems={navItems}
      accentColor="slate"
      pathname={pathname}
      switchLink={{ href: '/sandbox', label: '→ Sandbox' }}
      headerExtra={<TenantSwitcher />}
    >
      {children}
    </AppShell>
  )
}
