/**
 * #1111 hang-pilot: a böngészős hang-beszélgetés MCP-hozzáférése. Engedélylista: ami nincs itt
 * (köztük minden később felvett eszköz), az hang közben nem listázható és nem hívható.
 *
 * A token az OpenAI-hoz is eljut, ezért a korlátot itt, a szerveren kényszerítjük ki, nem csak a
 * szolgáltatói `allowed_tools` mezőben.
 */
const VOICE_ALLOWED_TOOLS = new Set<string>([
  'kb_search',
  'kb_list_index',
  'kb_get_page',
  'kb_get_document',
  'platform.project_memory.read',
  'platform.work_file.list',
  'platform.work_file.read',
  'platform.work_file.append',
])

export const VOICE_TOOL_BLOCKED_MESSAGE =
  'Ezt az eszközt hangos beszélgetés közben nem használhatod. Mondd el a hívónak, hogy ezt hang közben nem tudod elintézni.'

/**
 * A platform eszköznevei pontot tartalmaznak, az OpenAI példái viszont csak pont nélküli neveket
 * mutatnak. Hang közben ezért alias megy ki, így ez nem lehet hibaforrás.
 */
export function voiceToolAlias(toolName: string): string {
  return toolName.replaceAll('.', '__')
}

export function toolNameFromVoiceAlias(alias: string): string {
  return alias.replaceAll('__', '.')
}

export function voiceAllowedToolAliases(): string[] {
  return [...VOICE_ALLOWED_TOOLS].map(voiceToolAlias)
}

export function voiceBlocksTool(principal: { voiceCall?: true }, toolName: string, args?: Record<string, unknown>): boolean {
  if (principal.voiceCall !== true) return false
  // A dokumentum olvasása engedett, de ez a kapcsoló egy wiki-tálca tételét le is foglalná, ami már írás.
  if (toolName === 'kb_get_document' && args?.claimForWiki !== undefined) return true
  return !VOICE_ALLOWED_TOOLS.has(toolName)
}

type VoiceLimitableServer = {
  registerTool: (...args: never[]) => unknown
  registerPrompt: (...args: never[]) => unknown
  registerResource: (...args: never[]) => unknown
}

/**
 * Csak az engedélylista kerül a szerverre, alias néven; a hívást a `tools/call` kezelő oldja vissza.
 * Prompt és erőforrás nem kerül fel, így a munkatárs eligazítása és a skillek sem olvashatók hang-tokennel.
 */
export function limitServerToVoiceTools(server: VoiceLimitableServer): void {
  const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown
  const limited = (name: string, ...rest: unknown[]) =>
    VOICE_ALLOWED_TOOLS.has(name) ? register(voiceToolAlias(name), ...rest) : undefined
  server.registerTool = limited as unknown as typeof server.registerTool
  server.registerPrompt = (() => undefined) as unknown as typeof server.registerPrompt
  server.registerResource = (() => undefined) as unknown as typeof server.registerResource
}
