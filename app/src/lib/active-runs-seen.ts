import { activeRunKey, type ActiveRun } from '@/lib/active-runs'

const STORAGE_KEY = 'active-runs:seen'
const MAX_STORED = 100

type SeenEntry = {
  key: string
  seenAt: string
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readEntries(): SeenEntry[] {
  if (!canUseStorage()) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SeenEntry =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as SeenEntry).key === 'string' &&
        typeof (item as SeenEntry).seenAt === 'string',
    )
  } catch {
    return []
  }
}

function writeEntries(entries: SeenEntry[]): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_STORED)))
  } catch {
    // quota / private mode — csendben elnyeljük
  }
}

/** Megnézett futás-kulcsok (legfrissebb seenAt elöl). */
export function loadSeenRunKeys(): Set<string> {
  return new Set(readEntries().map((e) => e.key))
}

export function markRunSeen(run: Pick<ActiveRun, 'kind' | 'id'>): void {
  const key = activeRunKey(run)
  const now = new Date().toISOString()
  const rest = readEntries().filter((e) => e.key !== key)
  writeEntries([{ key, seenAt: now }, ...rest])
}

/** Eltávolítja a már nem létező kulcsokat (opcionális prune a fetch után). */
export function pruneSeenRunKeys(validKeys: ReadonlySet<string>): void {
  const current = readEntries()
  const next = current.filter((e) => validKeys.has(e.key))
  if (next.length !== current.length) writeEntries(next)
}
