import {
  CONTROL_PLANE_NAV_CATALOG,
  type ControlPlaneNavCatalogEntry,
} from '@/lib/control-plane-nav'

export type ControlPlanePanelDef = {
  key: string
  title: string
  eyebrow: string
  /** Teljes oldal mély-link (menekülő-út). */
  href: string
}

const EYEBROW: Record<string, string> = {
  board: 'Munkatábla',
  automation: 'Automatizálás',
  admin: 'Adminisztráció',
  staff: 'Munkatársak',
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
      href: entry.href,
    })
  }
  return panels
}

const EXTRA_PANELS: ControlPlanePanelDef[] = [
  {
    key: 'agent.new',
    title: 'Új munkatárs felvétele',
    eyebrow: 'Csapat',
    href: '/control-plane/agents/new',
  },
  {
    key: 'automation.scheduled-tasks',
    title: 'Ütemezett feladatok',
    eyebrow: 'Automatizálás',
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

/** Nav href → panel kulcs (header kattintáshoz). */
export function panelKeyForHref(href: string): string | null {
  const match = Object.values(CONTROL_PLANE_PANELS).find((p) => p.href === href)
  return match?.key ?? null
}
