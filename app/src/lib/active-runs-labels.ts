import type { ActiveRun } from '@/lib/active-runs'

export type RunTone = 'neutral' | 'success' | 'warning' | 'danger'

export function kindLabel(kind: ActiveRun['kind']): string {
  return kind === 'chat_turn' ? 'Chat' : 'Feladat'
}

export function statusLabel(run: ActiveRun): string | null {
  if (run.phase === 'active') {
    if (run.status === 'cancelling') return 'Leállítás…'
    if (run.status === 'ready') return 'Végrehajtásra vár'
    if (run.status === 'awaiting_human') return 'Döntésre vár'
    if (run.status === 'needs_info') return 'Információra vár'
    if (run.status === 'in_progress') return 'Fut'
    if (run.status === 'stalled') return 'Megállt'
    if (run.status === 'running' || run.status === 'streaming') return 'Fut'
    if (run.status === 'queued') return 'Sorban áll'
    return null
  }
  switch (run.status) {
    case 'completed':
    case 'done':
      return 'Kész'
    case 'cancelled':
      return 'Leállítva'
    case 'failed':
    case 'exhausted':
      return 'Sikertelen'
    case 'rejected':
      return 'Elutasítva'
    default:
      return 'Lefutott'
  }
}

/**
 * A „Kész" a leggyakoribb állapot — sorokban ez csak halk szöveg, hogy ne
 * ismétlődjön minden során egy hangsúlyos pirula. Minden más állapot kiemelt.
 */
export function isRoutineStatus(run: ActiveRun): boolean {
  return run.phase === 'completed' && (run.status === 'completed' || run.status === 'done')
}

export function runPhaseTone(run: ActiveRun): RunTone {
  if (run.phase === 'active') {
    if (
      run.status === 'awaiting_human' ||
      run.status === 'needs_info' ||
      run.status === 'ready'
    ) {
      return 'warning'
    }
    if (run.status === 'cancelling') return 'danger'
    if (run.status === 'stalled') return 'danger'
    return 'neutral'
  }
  if (run.status === 'rejected' || run.status === 'failed' || run.status === 'exhausted') {
    return 'danger'
  }
  if (run.status === 'cancelled') return 'warning'
  return 'success'
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function clock(date: Date): string {
  return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

/** Napi csoport-fejléc a listákhoz: „Ma” / „Tegnap” / „aug. 1.”. */
export function runDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Ma'
  if (days === 1) return 'Tegnap'
  return date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/** Sor jobb széle: mai napnál óra:perc, régebbinél rövid dátum. */
export function formatRunClock(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return clock(date)
  if (days === 1) return `tegnap ${clock(date)}`
  return date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/** Futó munka élő órája — perc:mp, a chat „Éppen dolgozik” sávjához. */
export function formatWorkElapsedMmSs(startedAtMs: number, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Aktív futásnál a kor a fontos információ, nem az indulás órája. */
export function formatRunElapsed(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'most indult'
  if (minutes < 60) return `${minutes} perce`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} órája`
  return `${Math.floor(hours / 24)} napja`
}

/** Teljes időpont a tooltiphez — a rövid címke mögött mindig ott a pontos érték. */
export function formatRunTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
