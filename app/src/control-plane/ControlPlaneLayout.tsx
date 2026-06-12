import { Link, Outlet } from 'react-router-dom'
import { AppShell } from '../shared/components/AppShell'

const navItems = [
  { to: '/control-plane', label: 'Áttekintés' },
  { to: '/control-plane/board', label: 'Board' },
]

export function ControlPlaneLayout() {
  return (
    <AppShell
      appName="Control Plane"
      appSubtitle="AI Governance & Orchestration Hub"
      navItems={navItems}
      accentColor="slate"
      switchLink={{
        to: '/sandbox',
        label: '→ Sandbox munkatér',
      }}
    >
      <Outlet />
    </AppShell>
  )
}

export function DemoGuide() {
  return (
    <div className="mb-6 rounded-lg border border-sky-800/50 bg-sky-950/30 p-4 text-left">
      <p className="text-sm font-medium text-sky-200">Demó-forgatókönyv (M1)</p>
      <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-sky-300/80">
        <li>
          Nyisd meg a{' '}
          <Link to="/sandbox" className="underline hover:text-sky-100">
            Sandbox munkateret
          </Link>{' '}
          és tölts fel egy számlát
        </li>
        <li>Várj a szimulált feldolgozásra, majd küldd jóváhagyásra</li>
        <li>
          A ticket megjelenik a{' '}
          <Link to="/control-plane/board" className="underline hover:text-sky-100">
            Board
          </Link>{' '}
          „Awaiting Human” oszlopában
        </li>
        <li>Nyisd meg a tickettet és hagyd jóvá — audit napló frissül</li>
      </ol>
    </div>
  )
}
