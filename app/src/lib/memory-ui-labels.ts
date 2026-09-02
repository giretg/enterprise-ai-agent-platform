/**
 * Projekt-memória felületi címkék — a control-plane panel és a chat-kártya
 * ugyanebből a szótárból dolgozik, hogy a belső típusnevek (project_state,
 * salience, constraint) ne szivárogjanak a felhasználó elé.
 */

export const GENERAL_MEMORY_PROJECT_KEY = '__general__'

export function memoryProjectKeyLabel(key: string, labels?: Record<string, string>): string {
  if (labels?.[key]) return labels[key]
  return key === GENERAL_MEMORY_PROJECT_KEY ? 'Általános (alapértelmezett)' : key
}

/** Magas / alacsony fontosság; a középső sávot szándékosan elnyeljük, az zaj. */
export function memoryImportanceLabel(salience: number): string | null {
  if (salience >= 0.75) return 'Kiemelt'
  if (salience < 0.25) return 'Háttérbe szorult'
  return null
}

export const MEMORY_IMPORTANCE_HINT =
  'Az agent ennyire tartja fontosnak ezt az emléket, amikor a beszélgetéshez válogat.'

export const MEMORY_OPERATION_LABELS: Record<string, string> = {
  create: 'Új emlék',
  update: 'Frissítés',
  supersede: 'Leváltás',
  archive: 'Archiválás',
  delete_request: 'Törlés',
  demote: 'Háttérbe sorolás',
  refresh_needed: 'Frissítés kell',
  conflict_review: 'Ellentmondás',
  rollback: 'Visszaállítás',
}

export function memoryOperationLabel(operation: string): string {
  return MEMORY_OPERATION_LABELS[operation] ?? operation
}

export const MEMORY_CANDIDATE_STATUS_LABELS: Record<string, string> = {
  proposed: 'jóváhagyásra vár',
  modified: 'módosítva, jóváhagyásra vár',
  ticketed: 'ticketben vár',
  approved: 'jóváhagyva',
  rejected: 'elvetve',
}

export function memoryCandidateStatusLabel(status: string): string {
  return MEMORY_CANDIDATE_STATUS_LABELS[status] ?? status
}

export function memoryVersionChangeLabel(changeSet: unknown): string | null {
  if (!changeSet || typeof changeSet !== 'object' || Array.isArray(changeSet)) return null
  const record = changeSet as { operation?: unknown; toVersion?: unknown }
  const operation = typeof record.operation === 'string' ? record.operation : null
  if (!operation) return null
  if (operation === 'rollback') {
    const toVersion = typeof record.toVersion === 'number' ? record.toVersion : null
    return toVersion != null ? `Visszaállítva a ${toVersion}. állapotra` : 'Visszaállítás'
  }
  return memoryOperationLabel(operation)
}

export function memoryMaintenanceNotice(input: {
  proposed: number
  scanned: number
  skipped: number
}): string {
  const skippedBit =
    input.skipped > 0
      ? ` ${input.skipped} javaslat a keret miatt kimaradt.`
      : ''
  if (input.scanned === 0) {
    return `Ebben a gyűjtőben most nincs átnézhető emlék.${skippedBit}`
  }
  const scannedBit = `${input.scanned} emléket`
  if (input.proposed <= 0) {
    return `Átnéztünk ${scannedBit}. Semmi nem szorul frissítésre, archiválásra vagy felülvizsgálatra — nincs teendőd.${skippedBit}`
  }
  const proposedBit = input.proposed === 1 ? '1 javaslat' : `${input.proposed} javaslat`
  return `Átnéztünk ${scannedBit}, és ${proposedBit} készült. Alább jóváhagyhatod vagy elvetheted; amíg nem döntesz, semmi nem változik.${skippedBit}`
}

export function extraMemoryChunks<T extends { id: string }>(
  active: T[],
  shown: Array<{ id: string } | null | undefined>,
): T[] {
  const ids = new Set<string>()
  for (const item of shown) {
    if (item?.id) ids.add(item.id)
  }
  return active.filter((chunk) => !ids.has(chunk.id))
}
