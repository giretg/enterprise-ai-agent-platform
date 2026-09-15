/**
 * Agent-diagnosztika: tiszta (hálózat- és DB-mentes) statikus ellenőrzések.
 *
 * Azt válaszolja meg írás NÉLKÜL, hogy az agent konfigurációja elméletileg
 * működőképes-e: van-e az engedélyezett eszközök mögött bekötött kapcsolat,
 * lefedi-e a grant scope-ja az írási jogot, és zöldek-e a skillek.
 * Az élő (read-only + opt-in próba-írás) réteg az `agent-probes.ts`-ben van.
 */

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'unknown'

/** Az agent-adatlap `SettingsSectionShell` szekció-azonosítója — ide ugrik a „Javítás". */
export type DiagnosticFixSection = 'eszkozok' | 'kapcsolatok' | 'skillek' | 'motor'

export interface DiagnosticCheck {
  id: string
  label: string
  status: DiagnosticStatus
  /** Rövid, nem technikai magyarázat + tennivaló. Soha nem tartalmaz titkot. */
  detail: string
  fixSection: DiagnosticFixSection
}

export interface DiagnosticsStaticInput {
  /** Az agenten `allowed=true` tool-nevek. */
  allowedTools: readonly string[]
  /** Az agenthez kötött connector-típusok (pl. 'gmail', 'google_drive', 'http_api'). */
  boundConnectorTypes: readonly string[]
  /**
   * Írásjog-lefedettség a grant scope alapján (grant NÉLKÜL nem dönthető el):
   *  - `true`: a scope lefedi az írást (elméletileg OK),
   *  - `false`: az írás-eszköz engedélyezve van, de a scope csak olvasásra elég,
   *  - `null`: nincs vonatkozó írás-eszköz vagy nincs grant — nincs mit vizsgálni.
   */
  gmailSendCovered: boolean | null
  driveWriteCovered: boolean | null
  /** Kijelölt-írás (selected_write): az írás csak app-létrehozott/kijelölt fájlokon megy. */
  driveWriteIsSelectedOnly?: boolean
  skills: Array<{
    name: string
    /** A skill-panel readiness-színe (zöld/sárga/piros). */
    color: 'green' | 'yellow' | 'red'
    enabled: boolean
  }>
  /** Vázlat agent nem kap feladatot — a teszt ettől még lefut, de jelezzük. */
  isDraft: boolean
}

function familyAllowed(allowedTools: readonly string[], match: (tool: string) => boolean): string[] {
  return allowedTools.filter(match)
}

const isGmailTool = (tool: string): boolean =>
  tool.startsWith('gmail_') || tool === 'mailbox_count'
const isDriveTool = (tool: string): boolean =>
  tool.startsWith('google_drive_') ||
  tool.startsWith('google_docs_') ||
  tool.startsWith('google_sheets_') ||
  tool.startsWith('google_slides_')
const isHttpTool = (tool: string): boolean => tool.startsWith('http_api_')
const isKbTool = (tool: string): boolean => tool.startsWith('kb_')

/**
 * Írás-eszközök, amikhez a grant scope-ját külön ellenőrizzük. A `gmail_send`
 * szándékosan NINCS itt: a küldés emberi-jóváhagyás kapuja policy, nem scope —
 * a scope-ot a piszkozat (`gmail_create_draft`) bizonyítja. A Drive-írástoolok
 * kanonikus halmaza: `isDriveWriteTool` (google-drive-scopes.ts).
 */
export const GMAIL_WRITE_TOOLS = ['gmail_create_draft', 'gmail_send'] as const

export function computeAgentDiagnostics(input: DiagnosticsStaticInput): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = []
  const bound = new Set(input.boundConnectorTypes)

  const families: Array<{ type: string; label: string; tools: string[] }> = [
    { type: 'gmail', label: 'Gmail', tools: familyAllowed(input.allowedTools, isGmailTool) },
    { type: 'google_drive', label: 'Google Drive', tools: familyAllowed(input.allowedTools, isDriveTool) },
    { type: 'http_api', label: 'HTTP API', tools: familyAllowed(input.allowedTools, isHttpTool) },
    { type: 'knowledge_base', label: 'Tudásbázis', tools: familyAllowed(input.allowedTools, isKbTool) },
  ]
  for (const family of families) {
    if (family.tools.length === 0) continue
    if (bound.has(family.type)) {
      checks.push({
        id: `binding:${family.type}`,
        label: `${family.label}: ${family.tools.length} engedélyezett eszköz be van kötve`,
        status: 'ok',
        detail: `${family.tools.length} eszköz használhatja a bekötött ${family.label} kapcsolatot.`,
        fixSection: 'kapcsolatok',
      })
    } else {
      checks.push({
        id: `binding:${family.type}`,
        label: `${family.label}: engedélyezett eszközhöz nincs kapcsolat`,
        status: 'fail',
        detail: `${family.tools.length} eszköz engedélyezve van (${family.tools.slice(0, 3).join(', ')}${family.tools.length > 3 ? '…' : ''}), de nincs hozzá ${family.label} kapcsolat kötve — ezek most nem működnének.`,
        fixSection: 'kapcsolatok',
      })
    }
  }

  // Írásjog-lefedettség (statikus — ez fogja meg az „elfelejtett írásjog" hibát).
  if (input.gmailSendCovered === false) {
    checks.push({
      id: 'write:gmail',
      label: 'Gmail írás: a kapcsolat csak olvasásra elég',
      status: 'fail',
      detail:
        'Van engedélyezett Gmail-író eszköz (piszkozat), de a megadott fiók-hozzáférés csak olvasásra jogosít — az agent nem tudna piszkozatot létrehozni.',
      fixSection: 'kapcsolatok',
    })
  } else if (input.gmailSendCovered === true) {
    checks.push({
      id: 'write:gmail',
      label: 'Gmail írás: a kapcsolat lefedi (elméleti)',
      status: 'ok',
      detail: 'A fiók-hozzáférés piszkozat-létrehozásra is jogosít.',
      fixSection: 'kapcsolatok',
    })
  }
  if (input.driveWriteCovered === false) {
    checks.push({
      id: 'write:drive',
      label: 'Drive írás: a kapcsolat csak olvasásra elég',
      status: 'fail',
      detail:
        'Van engedélyezett Drive-író eszköz, de a megadott hozzáférés csak olvasásra jogosít — az írás most biztosan elakadna.',
      fixSection: 'kapcsolatok',
    })
  } else if (input.driveWriteCovered === true) {
    checks.push({
      id: 'write:drive',
      label: 'Drive írás: a kapcsolat lefedi (elméleti)',
      status: 'ok',
      detail: input.driveWriteIsSelectedOnly
        ? 'Az írás a kijelölt / app-létrehozott fájlokra korlátozódik — ez a biztonságos alapbeállítás.'
        : 'A hozzáférés írási jogot is ad.',
      fixSection: 'kapcsolatok',
    })
  }

  // Skillek összesítve (a részletek a skill-panelen vannak).
  const activeSkills = input.skills.filter((s) => s.enabled)
  const red = activeSkills.filter((s) => s.color === 'red')
  const yellow = activeSkills.filter((s) => s.color === 'yellow')
  if (activeSkills.length > 0) {
    if (red.length > 0) {
      checks.push({
        id: 'skills',
        label: `Skillek: ${red.length} nem működőképes`,
        status: 'fail',
        detail: `${red.map((s) => s.name).slice(0, 3).join(', ')}${red.length > 3 ? '…' : ''} olyan eszközt igényel, amihez nincs kapcsolat — amíg ez nincs meg, a skill nem működik.`,
        fixSection: 'skillek',
      })
    } else if (yellow.length > 0) {
      checks.push({
        id: 'skills',
        label: `Skillek: ${yellow.length} hiányos joggal`,
        status: 'warn',
        detail: `${yellow.map((s) => s.name).slice(0, 3).join(', ')}${yellow.length > 3 ? '…' : ''} eszköze nincs engedélyezve, de pótolható.`,
        fixSection: 'skillek',
      })
    } else {
      checks.push({
        id: 'skills',
        label: `Skillek: mind a(z) ${activeSkills.length} működőképes`,
        status: 'ok',
        detail: 'Minden bekapcsolt skill eszköze engedélyezve van.',
        fixSection: 'skillek',
      })
    }
  }

  if (input.isDraft) {
    checks.push({
      id: 'lifecycle',
      label: 'Az agent még vázlat',
      status: 'warn',
      detail: 'Vázlat agent nem kap feladatot — a kapcsolatok ettől még tesztelhetők, de élesben nem dolgozna.',
      fixSection: 'motor',
    })
  }

  if (checks.length === 0) {
    checks.push({
      id: 'empty',
      label: 'Nincs vizsgálandó eszköz',
      status: 'unknown',
      detail: 'Az agentnek nincs engedélyezett külső eszköze — csak beszélgetni tud. Ha kell neki valami, az Eszközöknél add hozzá.',
      fixSection: 'eszkozok',
    })
  }
  return checks
}
