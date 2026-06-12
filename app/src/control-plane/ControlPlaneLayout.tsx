import { Link, Outlet } from 'react-router-dom'
import { AppShell } from '../shared/components/AppShell'

const navItems = [
  { to: '/control-plane', label: 'Áttekintés' },
  { to: '/control-plane/board', label: 'Board' },
  { to: '/control-plane/agents', label: 'Agentek' },
  { to: '/control-plane/audit', label: 'Audit log' },
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
      <p className="text-sm font-medium text-sky-200">Demó-forgatókönyv</p>
      <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-sky-300/80">
        <li>
          <Link to="/sandbox" className="underline hover:text-sky-100">
            Sandbox
          </Link>
          : számla feltöltés → jóváhagyásra küldés
        </li>
        <li>
          <Link to="/control-plane/board" className="underline hover:text-sky-100">
            Board
          </Link>
          : ticket jóváhagyás (Awaiting Human)
        </li>
        <li>
          Board →{' '}
          <Link
            to="/control-plane/tickets/TKT-1030"
            className="underline hover:text-sky-100"
          >
            TKT-1030
          </Link>
          : tanítási ticket jóváhagyás (memória diff)
        </li>
        <li>
          <Link
            to="/control-plane/agents/agent-bookkeeper-01"
            className="underline hover:text-sky-100"
          >
            Könyvelő Agent
          </Link>
          : memória verzió + Rollback
        </li>
        <li>
          <Link to="/control-plane/audit" className="underline hover:text-sky-100">
            Audit log
          </Link>
          : minden lépés visszakereshető
        </li>
      </ol>
    </div>
  )
}
