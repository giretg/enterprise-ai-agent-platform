import { Link, Outlet } from 'react-router-dom'
import { AppShell } from '../shared/components/AppShell'

const navItems = [
  { to: '/control-plane', label: 'Kezdőlap' },
  { to: '/control-plane/board', label: 'Feladatok' },
  { to: '/control-plane/agents', label: 'A csapat' },
  { to: '/control-plane/resources', label: 'Eszköztár' },
  { to: '/control-plane/models', label: 'Modellek' },
  { to: '/control-plane/playbook', label: 'Forgatókönyv' },
  { to: '/control-plane/audit', label: 'Napló' },
  { to: '/control-plane/iam', label: 'Emberek' },
  { to: '/control-plane/admin', label: 'Beállítások' },
]

export function ControlPlaneLayout() {
  return (
    <AppShell
      appName="Excellence AI"
      appSubtitle="A te AI-csapatod műhelye"
      navItems={navItems}
      accentColor="slate"
      switchLink={{
        to: '/sandbox',
        label: 'Műhelybe lépés →',
      }}
    >
      <Outlet />
    </AppShell>
  )
}

export function DemoGuide() {
  const linkCls = 'font-medium text-honey underline-offset-2 hover:underline'
  return (
    <div className="atelier-soft mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left text-sm text-ink-soft">
      <span className="mr-1 text-base" aria-hidden>
        🧭
      </span>
      <span className="font-medium text-ink">Körbevezetlek:</span>
      <Link to="/sandbox" className={linkCls}>
        a műhelyben
      </Link>
      <span>tölts fel egy számlát, hagyd jóvá, majd nézd meg a</span>
      <Link to="/control-plane/playbook" className={linkCls}>
        forgatókönyvet
      </Link>
      <span>· a</span>
      <Link to="/control-plane/board" className={linkCls}>
        feladatoknál
      </Link>
      <Link to="/control-plane/tickets/TKT-1030" className={linkCls}>
        a TKT-1030
      </Link>
      <span>mutatja a tanítást és visszaállítást · ismerd meg</span>
      <Link to="/control-plane/agents" className={linkCls}>
        a csapatot
      </Link>
    </div>
  )
}
