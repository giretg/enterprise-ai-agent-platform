/**
 * Képesség-pakli (#957 WP-2): a platform-eszközök üzleti nyelvű kártyákba
 * rendezve, rendszer szerint. Kártyánként három állás: ki / olvas / ír is.
 * Az „ír” mindig magában foglalja az olvasást.
 *
 * Minden normál platform-eszköz pontosan egy kártyán szerepel (teszt őrzi),
 * így a pakli nem rejthet el és nem duplikálhat jogot. Mentéskor ugyanaz a
 * `updateAgentCapabilities` fut, mint az adatlapon.
 */

export const CAPABILITY_DECK_CATEGORIES = ['mail', 'documents', 'sheets', 'company', 'knowledge', 'compute'] as const
export type CapabilityDeckCategory = (typeof CAPABILITY_DECK_CATEGORIES)[number]

export type CapabilityDeckLevel = 'off' | 'read' | 'write'

export type CapabilityDeckCard = {
  id: CapabilityDeckCategory
  /** Olvasó eszközök — „olvas” állásban ezek kapcsolnak be. */
  readTools: readonly string[]
  /** Író / küldő eszközök — csak „ír is” állásban. */
  writeTools: readonly string[]
  /** Személyes fiók-összekötés kellhet hozzá (Kapcsolt fiókok). */
  needsAccount?: 'gmail' | 'drive'
}

export const CAPABILITY_DECK: readonly CapabilityDeckCard[] = [
  {
    id: 'mail',
    readTools: ['gmail_search', 'gmail_get_message', 'gmail_get_thread', 'gmail_list_labels', 'gmail_list_drafts'],
    writeTools: ['gmail_create_draft', 'gmail_send', 'gmail_modify_labels', 'gmail_trash'],
    needsAccount: 'gmail',
  },
  {
    id: 'documents',
    readTools: ['google_drive_search', 'google_drive_read_file'],
    writeTools: ['google_drive_create_folder', 'google_drive_upload_file', 'google_drive_update_file'],
    needsAccount: 'drive',
  },
  {
    id: 'sheets',
    readTools: [],
    writeTools: ['google_sheets_write_range'],
    needsAccount: 'drive',
  },
  {
    id: 'company',
    readTools: ['http_api_get', 'http_api_get_all', 'mcp_list_tools'],
    writeTools: ['http_api_request', 'mcp_call'],
  },
  {
    id: 'knowledge',
    readTools: ['kb_search', 'kb_list_index', 'kb_get_page', 'kb_get_document', 'kb_wiki_changes'],
    writeTools: ['kb_ingest', 'kb_wiki_write', 'kb_wiki_revert'],
  },
  {
    id: 'compute',
    readTools: ['sandbox_run'],
    writeTools: [],
  },
]

export function capabilityDeckTools(card: CapabilityDeckCard): string[] {
  return [...card.readTools, ...card.writeTools]
}

/** A kártya választható állásai (csak-író kártyán nincs „olvas”). */
export function capabilityDeckLevels(card: CapabilityDeckCard): CapabilityDeckLevel[] {
  const levels: CapabilityDeckLevel[] = ['off']
  if (card.readTools.length > 0) levels.push('read')
  if (card.writeTools.length > 0) levels.push('write')
  return levels
}

/**
 * A kártya jelenlegi állása a bekapcsolt eszközökből. Részleges kijelölés
 * (az adatlapon egyenként állítva) a legmagasabb teljesen bekapcsolt szint;
 * így a kártya soha nem mutat többet, mint ami valóban engedélyezett.
 */
export function capabilityDeckLevel(card: CapabilityDeckCard, enabled: ReadonlySet<string>): CapabilityDeckLevel {
  const all = (tools: readonly string[]) => tools.length > 0 && tools.every((tool) => enabled.has(tool))
  const readOk = card.readTools.length === 0 || all(card.readTools)
  if (card.writeTools.length > 0 && all(card.writeTools) && readOk) return 'write'
  if (card.readTools.length > 0 && all(card.readTools)) return 'read'
  return 'off'
}

/** Részben bekapcsolt-e (az adatlapon finomhangolt) — a kártya jelzi. */
export function capabilityDeckIsPartial(card: CapabilityDeckCard, enabled: ReadonlySet<string>): boolean {
  const tools = capabilityDeckTools(card)
  const on = tools.filter((tool) => enabled.has(tool)).length
  if (on === 0) return false
  const level = capabilityDeckLevel(card, enabled)
  const expected = level === 'write' ? tools.length : level === 'read' ? card.readTools.length : 0
  return on !== expected
}

/** Új eszközkészlet a kártya új állásával; a pakli többi kártyáját és a paklin kívüli eszközöket nem érinti. */
export function applyCapabilityDeckLevel(
  card: CapabilityDeckCard,
  level: CapabilityDeckLevel,
  enabled: ReadonlySet<string>,
): Set<string> {
  const next = new Set(enabled)
  for (const tool of capabilityDeckTools(card)) next.delete(tool)
  if (level === 'read' || level === 'write') for (const tool of card.readTools) next.add(tool)
  if (level === 'write') for (const tool of card.writeTools) next.add(tool)
  return next
}

/** Kapcsolat (connector) besorolása a pakli rendszer-csoportjaiba. */
export function capabilityCategoryForConnectorType(type: string): CapabilityDeckCategory {
  switch (type) {
    case 'gmail':
      return 'mail'
    case 'google_drive':
      return 'documents'
    case 'knowledge_base':
      return 'knowledge'
    case 'code_sandbox':
      return 'compute'
    default:
      return 'company'
  }
}
