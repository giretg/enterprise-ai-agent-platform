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
 */
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
