import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * #984 AI-adattárház: melyik AI munkatárs mit érhet el, a `Tenant.settings.warehouse`
 * alatt. Alapérték + agentenkénti felülírás. A hívó ember szerepe ettől függetlenül
 * továbbra is korlátoz (a szint csak szűkít). Kliens-oldalon is importálható.
 */
export const WAREHOUSE_SETTINGS_KEY = 'warehouse'

export const WAREHOUSE_AGENT_ACCESS_OPTIONS = [
  { value: 'off', label: 'Nincs hozzáférés', hint: 'A munkatárs nem látja az adattárházat.' },
  { value: 'read', label: 'Csak olvasás', hint: 'Kérdezhet és exportálhat, de nem tölthet be adatot.' },
  { value: 'import', label: 'Olvasás és betöltés', hint: 'Excelt is betölthet; új adatkészlethez/mezőhöz ember jóváhagyása kell.' },
] as const

export type WarehouseAgentAccess = (typeof WAREHOUSE_AGENT_ACCESS_OPTIONS)[number]['value']

export const DEFAULT_WAREHOUSE_AGENT_ACCESS: WarehouseAgentAccess = 'import'

export type WarehouseTenantSettings = {
  defaultAgentAccess: WarehouseAgentAccess
  agentAccess: Record<string, WarehouseAgentAccess>
}

export function isWarehouseAgentAccess(value: unknown): value is WarehouseAgentAccess {
  return WAREHOUSE_AGENT_ACCESS_OPTIONS.some((option) => option.value === value)
}

export function warehouseAgentAccessLabel(value: WarehouseAgentAccess): string {
  return WAREHOUSE_AGENT_ACCESS_OPTIONS.find((option) => option.value === value)!.label
}

export function readWarehouseSettings(settings: unknown): WarehouseTenantSettings {
  const raw = settingsRecord(settingsRecord(settings)[WAREHOUSE_SETTINGS_KEY])
  const agentAccess: Record<string, WarehouseAgentAccess> = {}
  for (const [agentId, level] of Object.entries(settingsRecord(raw.agentAccess))) {
    if (isWarehouseAgentAccess(level)) agentAccess[agentId] = level
  }
  return {
    defaultAgentAccess: isWarehouseAgentAccess(raw.defaultAgentAccess) ? raw.defaultAgentAccess : DEFAULT_WAREHOUSE_AGENT_ACCESS,
    agentAccess,
  }
}

export function warehouseAccessForAgent(settings: WarehouseTenantSettings, agentId: string): WarehouseAgentAccess {
  return settings.agentAccess[agentId] ?? settings.defaultAgentAccess
}

export function withWarehouseSettings(settings: unknown, next: WarehouseTenantSettings): Prisma.InputJsonValue {
  return {
    ...settingsRecord(settings),
    [WAREHOUSE_SETTINGS_KEY]: { defaultAgentAccess: next.defaultAgentAccess, agentAccess: next.agentAccess },
  }
}
