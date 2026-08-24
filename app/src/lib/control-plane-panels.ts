import {
  CONTROL_PLANE_NAV_CATALOG,
  type ControlPlaneNavCatalogEntry,
} from '@/lib/control-plane-nav'

/** Modal méret-skála — látványterv §4. */
export type ControlPlanePanelSize = 'sz-s' | 'sz-m' | 'sz-l' | 'sz-full'

export type ControlPlanePanelDef = {
  key: string
  title: string
  eyebrow: string
  size: ControlPlanePanelSize
  /** Teljes oldal mély-link (menekülő-út). */
  href: string
}

const SIZE_BY_KEY: Record<string, ControlPlanePanelSize> = {
  board: 'sz-full',
  'automation.playbooks': 'sz-l',
  'automation.step-templates': 'sz-l',
  'automation.processes': 'sz-l',
  'automation.scheduled-tasks': 'sz-m',
  'automation.monitors': 'sz-m',
  'admin.account': 'sz-m',
  'admin.connectors': 'sz-l',
  'admin.provisioning': 'sz-l',
  'admin.iam': 'sz-l',
  'admin.menu-access': 'sz-m',
  'admin.platform-tenants': 'sz-l',
  'admin.platform-iam': 'sz-l',
  'admin.platform-settings': 'sz-l',
  'admin.governance': 'sz-l',
  'admin.system': 'sz-l',
  'admin.audit': 'sz-full',
  'admin.agent-access': 'sz-l',
  'staff.training': 'sz-l',
  'staff.behavior-profiles': 'sz-l',
  'staff.skills': 'sz-l',
  'staff.apps': 'sz-l',
  'staff.sandbox-versions': 'sz-l',
  'agent.new': 'sz-m',
}

const EYEBROW: Record<string, string> = {
  board: 'Munkatábla',
  automation: 'Automatizálás',
  admin: 'Adminisztráció',
  staff: 'Csapat',
  'agent.new': 'Csapat',
}

function eyebrowForKey(key: string): string {
  if (EYEBROW[key]) return EYEBROW[key]
  const prefix = key.split('.')[0]
  return EYEBROW[prefix] ?? 'Menü'
}

function leafPanelsFromCatalog(
  entries: readonly ControlPlaneNavCatalogEntry[],
): ControlPlanePanelDef[] {
  const panels: ControlPlanePanelDef[] = []
  for (const entry of entries) {
    if ('children' in entry) {
      panels.push(...leafPanelsFromCatalog(entry.children))
      continue
    }
    panels.push({
      key: entry.key,
      title: entry.label,
      eyebrow: eyebrowForKey(entry.key),
      size: SIZE_BY_KEY[entry.key] ?? 'sz-m',
      href: entry.href,
    })
  }
  return panels
}

const EXTRA_PANELS: ControlPlanePanelDef[] = [
  { key: 'staff.training', title: 'Tanítás', eyebrow: 'Csapat', size: 'sz-l', href: '/control-plane/training' },
  {
    key: 'staff.behavior-profiles',
    title: 'Viselkedés-profilok',
    eyebrow: 'Csapat',
    size: 'sz-l',
    href: '/control-plane/behavior-profiles',
  },
  { key: 'staff.skills', title: 'Skill-katalógus', eyebrow: 'Csapat', size: 'sz-l', href: '/control-plane/skills' },
  { key: 'staff.apps', title: 'Mini-appok', eyebrow: 'Csapat', size: 'sz-l', href: '/control-plane/apps' },
  {
    key: 'staff.sandbox-versions',
    title: 'Sandbox verziók',
    eyebrow: 'Csapat',
    size: 'sz-l',
    href: '/control-plane/sandbox-versions',
  },
  {
    key: 'admin.agent-access',
    title: 'Kapcsolatok',
    eyebrow: 'Adminisztráció',
    size: 'sz-l',
    href: '/control-plane/agent-access',
  },
  {
    key: 'agent.new',
    title: 'Új munkatárs felvétele',
    eyebrow: 'Csapat',
    size: 'sz-m',
    href: '/control-plane/agents/new',
  },
  {
    key: 'automation.scheduled-tasks',
    title: 'Ütemezett feladatok',
    eyebrow: 'Automatizálás',
    size: 'sz-full',
    href: '/control-plane/board?scheduled=1',
  },
]

/** Panel-katalógus: nav levelek + sávból nyitható panelek. */
export const CONTROL_PLANE_PANELS: Record<string, ControlPlanePanelDef> = Object.fromEntries(
  [...leafPanelsFromCatalog(CONTROL_PLANE_NAV_CATALOG), ...EXTRA_PANELS].map((p) => [p.key, p]),
)

export function panelDefForKey(key: string | null | undefined): ControlPlanePanelDef | null {
  if (!key) return null
  return CONTROL_PLANE_PANELS[key] ?? null
}

/** Header-modalok: a viewport 90%-a (szélesség és magasság). */
export const CONTROL_PLANE_PANEL_VIEWPORT_CLASS = 'h-[90vh] w-[90vw] max-h-[90vh] max-w-[90vw]'

export function panelSizeClass(size: ControlPlanePanelSize): string {
  switch (size) {
    case 'sz-s':
    case 'sz-m':
    case 'sz-l':
    case 'sz-full':
      return CONTROL_PLANE_PANEL_VIEWPORT_CLASS
  }
}

/** Nav href → panel kulcs (header kattintáshoz). */
export function panelKeyForHref(href: string): string | null {
  const match = Object.values(CONTROL_PLANE_PANELS).find((p) => p.href === href)
  return match?.key ?? null
}
