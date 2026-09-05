/**
 * ESZKÖZ-HOZZÁFÉRÉS DIAGNOSZTIKA (issue #194, WP-5).
 *
 * ÜZLETI PROBLÉMA: a tulajdoni-lap ügyben az agent nem csinálta meg a feladatot,
 * és nem tudta megmondani, miért — három tool egyszerűen nem volt grantolva.
 * A felhasználó felé ez „az agent buta" tünetként jelent meg, holott egy hiányzó
 * jogosultsági sorról volt szó. Egyetlen képernyő elég lett volna hozzá.
 *
 * Ez a modul állítja elő azt a képernyőt: tool-onként megmondja, hogy az agent
 * LÁTJA-e az eszközt, van-e hozzá `Capability` sora, valóban HÍVHATJA-e, és
 * feloldható-e a végrehajtó handler. Az egyetlen operátori eltérés:
 *
 *   „Látja, de nincs joga" — az agent felkínálva látja, de a broker elutasítja.
 *                            Ez a tulajdoni-lap incidens alakja.
 * A chatben szándékosan rejtett (MCP-only) grantok nem eltérés: nincs teendő.
 */
import type { ToolBrokerRepository } from '@/repositories/interfaces'
import { resolveToolHandler } from './handlers/registry'
import type { ToolName } from './tool-broker-types'
import { TOOL_NAMES, TOOL_REGISTRY, type ToolSurface } from './tool-registry'

export type ToolCapabilityRowState = 'allowed' | 'denied' | 'missing'

export type ToolAccessDiagnosis = {
  tool: ToolName
  capability: string
  capabilityGroup: string
  /** Melyik modell-felületeken jelenik meg egyáltalán (a descriptor `surfaces`-e). */
  surfaces: readonly ToolSurface[]
  /** Látja-e az agent a vizsgált felületen (alap: `chat`). */
  visible: boolean
  /** A `Capability(agentId, toolName)` sor állapota. */
  capabilityRow: ToolCapabilityRowState
  /** Ténylegesen hívhatja-e (a jogosultsági kapu szempontjából). */
  allowed: boolean
  /** Van-e feloldható végrehajtó handler (`handlers/registry.ts`). */
  handlerResolvable: boolean
  /** A UI-nak szánt, hétköznapi nyelvű összefoglaló — vagy `null`, ha rendben van. */
  issue: ToolAccessIssue | null
}

export type ToolAccessIssue = 'visible_without_grant' | 'handler_missing'

export type AgentToolAccessReport = {
  agentId: string
  surface: ToolSurface
  tools: ToolAccessDiagnosis[]
  /** „Látja, de nincs joga" — a tulajdoni-lap típusú hiány. */
  visibleWithoutGrant: ToolAccessDiagnosis[]
  /** Grantolva + látható, de nincs végrehajtó — futásidejű hiba lenne. */
  handlerMissing: ToolAccessDiagnosis[]
}

/**
 * Egy agent teljes eszköz-hozzáférési képe. A `surface` alapból a `chat`, mert
 * a felhasználó ezt látja; az MCP-vetület ugyanígy vizsgálható.
 */
export async function diagnoseAgentToolAccess(
  deps: { tools: Pick<ToolBrokerRepository, 'findCapabilitiesForAgent'> },
  agentId: string,
  surface: ToolSurface = 'chat',
): Promise<AgentToolAccessReport> {
  const rows = await deps.tools.findCapabilitiesForAgent(agentId)
  return buildAgentToolAccessReport(agentId, rows, surface)
}

/**
 * Ugyanaz, tisztán — ha a hívó (pl. az agent admin oldal) MÁR betöltötte a
 * jogosultsági sorokat, ne kérdezze le még egyszer.
 */
export function buildAgentToolAccessReport(
  agentId: string,
  capabilityRows: ReadonlyArray<{ toolName: string; allowed: boolean }>,
  surface: ToolSurface = 'chat',
): AgentToolAccessReport {
  const byTool = new Map(capabilityRows.map((row) => [row.toolName, row.allowed]))

  const tools = TOOL_NAMES.map<ToolAccessDiagnosis>((tool) => {
    const descriptor = TOOL_REGISTRY[tool]
    const row = byTool.get(descriptor.capability)
    const capabilityRow: ToolCapabilityRowState =
      row === undefined ? 'missing' : row ? 'allowed' : 'denied'
    const allowed = capabilityRow === 'allowed'
    const visible = descriptor.surfaces.includes(surface)
    const handlerResolvable = resolveToolHandler(tool) !== undefined

    let issue: ToolAccessIssue | null = null
    if (allowed && visible && !handlerResolvable) issue = 'handler_missing'
    else if (visible && !allowed) issue = 'visible_without_grant'

    return {
      tool,
      capability: descriptor.capability,
      capabilityGroup: descriptor.capabilityGroup,
      surfaces: descriptor.surfaces,
      visible,
      capabilityRow,
      allowed,
      handlerResolvable,
      issue,
    }
  })

  return {
    agentId,
    surface,
    tools,
    visibleWithoutGrant: tools.filter((t) => t.issue === 'visible_without_grant'),
    handlerMissing: tools.filter((t) => t.issue === 'handler_missing'),
  }
}
