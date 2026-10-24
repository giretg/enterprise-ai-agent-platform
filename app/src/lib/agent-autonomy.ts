/**
 * Önállósági szint (#957 WP-3): egy csúszka a négy írási mód fölött.
 *
 * - Gyakornok: minden írás jóváhagyással (a séma-alapérték, legszigorúbb).
 * - Megbízható kolléga: memóriát önállóan ír; levelet, fájlt, céges rendszert
 *   jóváhagyással.
 * - Önálló: nem kér jóváhagyást — a platform kötelező kapui (pl. a veszélyesnek
 *   jelölt MCP-eszközök) ettől függetlenül mindig kérdeznek.
 *
 * A szint csak a négy módot állítja; a jóváhagyó és az egyenkénti finomhangolás
 * a „Részletek” alatt az adatlap ugyanazon űrlapjával történik.
 *
 * Céges felső korlát (#957 D3): a tenant-admin megadhatja a legmagasabb
 * választható szintet. A korlát mindig felülírja az agent beállítását — mentéskor
 * elutasít, futáskor a szigorúbbat alkalmazza.
 */
import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'
import type { AgentWriteApprovalModes, AgentWriteKind } from '@/lib/write-approval-modes'

export const AUTONOMY_LEVELS = ['trainee', 'trusted', 'autonomous'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'trainee'

const LEVEL_MODES: Record<AutonomyLevel, AgentWriteApprovalModes> = {
  trainee: { memory: 'approval', httpApi: 'approval', gmail: 'approval', drive: 'approval' },
  trusted: { memory: 'direct', httpApi: 'approval', gmail: 'approval', drive: 'approval' },
  autonomous: { memory: 'direct', httpApi: 'direct', gmail: 'direct', drive: 'direct' },
}

const KINDS: readonly AgentWriteKind[] = ['memory', 'httpApi', 'gmail', 'drive']

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return AUTONOMY_LEVELS.includes(value as AutonomyLevel)
}

export function writeModesForAutonomy(level: AutonomyLevel): AgentWriteApprovalModes {
  return { ...LEVEL_MODES[level] }
}

/** Melyik szintnek felel meg a mentett beállítás; egyedi keverék = `custom`. */
export function autonomyForWriteModes(modes: AgentWriteApprovalModes): AutonomyLevel | 'custom' {
  const match = AUTONOMY_LEVELS.find((level) =>
    KINDS.every((kind) => LEVEL_MODES[level][kind] === modes[kind]),
  )
  return match ?? 'custom'
}

/** Csúszka-pozíció (0–2); egyedi keveréknél a hozzá legközelebbi, szigorúbb szint. */
export function autonomySliderIndex(modes: AgentWriteApprovalModes): number {
  const level = autonomyForWriteModes(modes)
  if (level !== 'custom') return AUTONOMY_LEVELS.indexOf(level)
  return modes.memory === 'direct' ? 1 : 0
}

// ── Céges felső korlát (D3) ──────────────────────────────────────────────────

export const TENANT_AUTONOMY_CEILING_SETTING = 'agentAutonomyCeiling'

/** Beállítás nélkül nincs korlát (a korábbi működés). */
export const DEFAULT_TENANT_AUTONOMY_CEILING: AutonomyLevel = 'autonomous'

export function readTenantAutonomyCeiling(settings: unknown): AutonomyLevel {
  const raw = settingsRecord(settings)[TENANT_AUTONOMY_CEILING_SETTING]
  return isAutonomyLevel(raw) ? raw : DEFAULT_TENANT_AUTONOMY_CEILING
}

export function withTenantAutonomyCeiling(settings: unknown, ceiling: AutonomyLevel): Prisma.InputJsonValue {
  return { ...settingsRecord(settings), [TENANT_AUTONOMY_CEILING_SETTING]: ceiling }
}

export function isAutonomyLevelAllowed(level: AutonomyLevel, ceiling: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(level) <= AUTONOMY_LEVELS.indexOf(ceiling)
}

/** A korlátnál engedékenyebb írási módok (mentéskor ezek miatt utasítunk el). */
export function writeModesAboveCeiling(modes: AgentWriteApprovalModes, ceiling: AutonomyLevel): AgentWriteKind[] {
  return KINDS.filter((kind) => modes[kind] === 'direct' && LEVEL_MODES[ceiling][kind] !== 'direct')
}

/** Futáskor érvényes módok: ami a korlát fölött van, jóváhagyásra esik vissza. */
export function clampWriteModesToCeiling(
  modes: AgentWriteApprovalModes,
  ceiling: AutonomyLevel,
): AgentWriteApprovalModes {
  const out = { ...modes }
  for (const kind of writeModesAboveCeiling(modes, ceiling)) out[kind] = 'approval'
  return out
}

/** Javasolt szint (minta, AI-vázlat) a korláthoz igazítva. */
export function clampAutonomyToCeiling(level: AutonomyLevel, ceiling: AutonomyLevel): AutonomyLevel {
  return isAutonomyLevelAllowed(level, ceiling) ? level : ceiling
}
