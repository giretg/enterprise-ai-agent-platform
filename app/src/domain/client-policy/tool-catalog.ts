/**
 * Hermes Managed Client — eszköz-katalógus (#872, spec §5.6, D17, D19).
 *
 * Eszköznév (vagy `*` minta) → osztály. A Guard ebből dönt; a saját beépített listája csak offline
 * tartalék (D4). Minden Hermes-alapeszköz pontosan egy osztályba tartozik, „egyéb” nincs: ami nincs
 * a katalógusban, azt a Guard blokkolja és `tool_unclassified` eseménnyel jelzi (admin-lista).
 *
 * A tenant az ismeretlen eszközt pontos névvel sorolhatja be (a tenant-sor `capabilities.toolCatalog`
 * kulcsa); ez felülírja az alapértelmezést. A `toolsets` a Hermes alap-toolsete(i): a gép-padló
 * (`machine-floor.ts`) ebből számolja, melyik toolset tiltható le egészében.
 * Kliens-komponens is importálja: node-modul (crypto) ide nem kerülhet.
 */
export const TOOL_ACTIONS = ['allow', 'approve', 'deny'] as const // szigorúság szerint növekvő
export type ToolAction = (typeof TOOL_ACTIONS)[number]

export const TOOL_CLASSES = [
  'capability:code_execution:run',
  'capability:local_files:read',
  'capability:local_files:write',
  'capability:browser:use',
  'capability:web_search:use',
  'capability:local_memory:use',
  'capability:skills:read',
  'capability:skills:write',
  'capability:autonomous_run:use',
  'capability:external_services:use',
  'mcp',
  'always',
  'passthrough',
  'denied',
] as const
export type ToolClass = (typeof TOOL_CLASSES)[number]

export type ToolCatalogEntry = { pattern: string; class: ToolClass; toolsets?: readonly string[] }

const c = (cls: ToolClass, patterns: string[], toolsets?: string[]): ToolCatalogEntry[] =>
  patterns.map((pattern) => ({ pattern, class: cls, ...(toolsets ? { toolsets } : {}) }))

/** Kiinduló besorolás (Hermes v0.21.x, spec §5.6 táblája). */
export const DEFAULT_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  ...c('passthrough', ['tool_search', 'tool_describe', 'tool_call']),
  ...c('always', ['clarify', 'todo_list', 'todo', 'gui_tour', 'show_tip', 'apply_layout', 'focus_pane', 'desktop_project', 'react_to_message', 'setup_choose']),
  ...c('capability:code_execution:run', ['terminal', 'process_manage'], ['terminal']),
  ...c('capability:code_execution:run', ['execute_code'], ['code_execution']),
  ...c('capability:code_execution:run', ['read_terminal', 'close_terminal']),
  ...c('capability:local_files:read', ['read_file', 'search_files'], ['file']),
  ...c('capability:local_files:read', ['vision_analyze'], ['vision']),
  ...c('capability:local_files:write', ['write_file', 'patch'], ['file']),
  ...c('capability:browser:use', ['browser_*'], ['browser']),
  ...c('capability:browser:use', ['computer_use'], ['computer_use']),
  ...c('capability:browser:use', ['desktop_preview', 'drive_preview', 'annotate_preview', 'read_window_below']),
  ...c('capability:web_search:use', ['web_search'], ['web', 'search']),
  ...c('capability:web_search:use', ['web_extract'], ['web']),
  ...c('capability:web_search:use', ['x_search'], ['x_search']),
  ...c('capability:local_memory:use', ['memory'], ['memory']),
  ...c('capability:local_memory:use', ['session_search'], ['session_search']),
  ...c('capability:skills:read', ['skills_list', 'skill_view'], ['skills']),
  ...c('capability:skills:write', ['skill_manage'], ['skills']),
  ...c('capability:skills:write', ['manage_catalog']),
  ...c('capability:autonomous_run:use', ['delegate_task'], ['delegation']),
  ...c('capability:autonomous_run:use', ['cronjob_manage'], ['cronjob']),
  ...c('capability:autonomous_run:use', ['kanban_*'], ['kanban']),
  ...c('capability:autonomous_run:use', ['start_chat'], ['start_chat']),
  ...c('capability:external_services:use', ['image_generate'], ['image_gen']),
  ...c('capability:external_services:use', ['video_generate', 'xai_video_edit', 'xai_video_extend'], ['video_gen']),
  ...c('capability:external_services:use', ['text_to_speech'], ['tts']),
  ...c('capability:external_services:use', ['manage_connections'], ['connections']),
  // ponytail: a `video_analyze` gateway-útja még mérendő (spec §5.6); addig a szigorúbb osztály.
  ...c('capability:external_services:use', ['video_analyze'], ['video']),
  ...c('capability:external_services:use', ['discord'], ['discord']),
  ...c('capability:external_services:use', ['discord_admin'], ['discord_admin']),
  ...c('capability:external_services:use', ['feishu_doc_read'], ['feishu_doc']),
  ...c('capability:external_services:use', ['feishu_drive_*'], ['feishu_drive']),
  ...c('capability:external_services:use', ['yb_*'], ['yuanbao']),
  ...c('mcp', ['mcp__*']),
]

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/

/** A tenant-sor `capabilities.toolCatalog`-ja: pontos név → osztály. Hibás tétel kimarad. */
export function parseTenantToolCatalog(capabilities: unknown): Record<string, ToolClass> {
  const raw = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? (capabilities as Record<string, unknown>).toolCatalog : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([name, cls]) =>
    TOOL_NAME.test(name) && (TOOL_CLASSES as readonly unknown[]).includes(cls))) as Record<string, ToolClass>
}

export function isToolName(value: string): boolean {
  return TOOL_NAME.test(value)
}

/** Tenant-besorolás elöl (pontos név, felülír), utána az alapértelmezés az azonos minták nélkül. */
export function effectiveToolCatalog(tenant: Record<string, ToolClass>): ToolCatalogEntry[] {
  const own = Object.entries(tenant).sort(([a], [b]) => a.localeCompare(b)).map(([pattern, cls]) => ({ pattern, class: cls }))
  return [...own, ...DEFAULT_TOOL_CATALOG.filter((e) => !Object.hasOwn(tenant, e.pattern))]
}

const matches = (pattern: string, name: string) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name

/** Pontos név előbb, utána a leghosszabb illeszkedő `*` minta; null = besorolatlan. A Guard ugyanígy dönt. */
export function classifyTool(catalog: readonly ToolCatalogEntry[], name: string): ToolClass | null {
  const exact = catalog.find((e) => e.pattern === name)
  if (exact) return exact.class
  let best: ToolCatalogEntry | null = null
  for (const e of catalog) {
    if (e.pattern.endsWith('*') && matches(e.pattern, name) && (!best || e.pattern.length > best.pattern.length)) best = e
  }
  return best?.class ?? null
}

export type UnclassifiedToolUse = { tool: string; attempts: number; lastSeenAt: Date; hermesVersion: string | null }

/** Az admin-lista: a már besorolt (vagy azóta tiltott) eszköz kimarad. */
export function stillUnclassified(rows: readonly UnclassifiedToolUse[], catalog: readonly ToolCatalogEntry[]): UnclassifiedToolUse[] {
  return rows.filter((r) => classifyTool(catalog, r.tool) === null)
}
