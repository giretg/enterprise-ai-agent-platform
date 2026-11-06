import { workFilesPagePath } from '@/lib/work-file-link'

export type AgentProductKind = 'miniApps' | 'knowledge' | 'workFiles' | 'scheduledTasks'

export type AgentProductItem = { label: string; href: string }

/**
 * Egy gomb a munkatárs-dobozon. Egy tételnél közvetlenül azt nyitja, több tételnél menüt,
 * tétel nélkül a `href` oldalt. A `count` a teljes szám, a menü ennél kevesebbet is mutathat.
 */
export type AgentProductLink = {
  kind: AgentProductKind
  count: number
  items: AgentProductItem[]
  href: string
}

/** A menü ennyi tételt mutat, a többi az „Összes megnyitása” sorral érhető el. */
const MENU_ITEM_LIMIT = 6

function withItems(kind: AgentProductKind, items: AgentProductItem[], href: string): AgentProductLink {
  return { kind, count: items.length, items: items.slice(0, MENU_ITEM_LIMIT), href }
}

/** Csak az kap gombot, ami létezik: a munkatárs-doboz ne vezessen üres oldalra. */
export function buildAgentProductLinks(input: {
  agentId: string
  miniApps: ReadonlyArray<{ id: string; name: string }>
  wikis: ReadonlyArray<{ connectorId: string; name: string; hasPages: boolean }>
  /** A legutóbb módosított munkafájl projektje; `undefined`: nincs látható munkafájl. */
  latestWorkFileProjectKey?: string
  scheduledTaskCount: number
}): AgentProductLink[] {
  const agentPage = `/control-plane/agents/${input.agentId}`
  const links: AgentProductLink[] = []
  if (input.miniApps.length > 0) {
    links.push(
      withItems(
        'miniApps',
        input.miniApps.map((app) => ({ label: app.name, href: `/control-plane/mini-apps/${app.id}` })),
        `${agentPage}?section=miniappok`,
      ),
    )
  }
  if (input.wikis.length > 0) {
    links.push(
      withItems(
        'knowledge',
        input.wikis.map((wiki) => ({
          label: wiki.name,
          // Az olvasó nézet csak kész oldalakkal hasznos; forrásdokumentumok a sima nézetben látszanak.
          href: `/control-plane/knowledge/${wiki.connectorId}${wiki.hasPages ? '?tab=reader' : ''}`,
        })),
        `${agentPage}?section=tudasbazis`,
      ),
    )
  }
  if (input.latestWorkFileProjectKey !== undefined) {
    links.push({
      kind: 'workFiles',
      count: 0,
      items: [],
      href: workFilesPagePath(input.latestWorkFileProjectKey),
    })
  }
  if (input.scheduledTaskCount > 0) {
    links.push({
      kind: 'scheduledTasks',
      count: input.scheduledTaskCount,
      items: [],
      href: `/control-plane/scheduled-tasks?agent=${input.agentId}`,
    })
  }
  return links
}

