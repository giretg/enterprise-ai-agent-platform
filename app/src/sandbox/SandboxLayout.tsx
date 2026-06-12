import { Outlet } from 'react-router-dom'
import { AppShell } from '../shared/components/AppShell'

const navItems = [{ to: '/sandbox', label: 'Könyvelő munkatér' }]

export function SandboxLayout() {
  return (
    <AppShell
      appName="Sandbox"
      appSubtitle="Agent Workspace — Ostoros-Novaj Agrár Kft."
      navItems={navItems}
      accentColor="teal"
      switchLink={{
        to: '/control-plane',
        label: '→ Control Plane',
      }}
    >
      <Outlet />
    </AppShell>
  )
}
