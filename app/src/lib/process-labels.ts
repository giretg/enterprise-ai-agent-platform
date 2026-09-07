import type { ProcessStatus } from '@prisma/client'

export const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  created: 'Létrehozva',
  running: 'Fut',
  awaiting_human: 'Emberre vár',
  blocked: 'Blokkolva',
  completed: 'Befejezve',
  failed: 'Hiba',
  cancelled: 'Megszakítva',
}

/** Folyamat-állapot -> Tailwind osztály, a board badge-hez és a Folyamatok nézetekhez. */
export const PROCESS_STATUS_CLASS: Record<ProcessStatus, string> = {
  created: 'bg-ink/8 text-ink-soft',
  running: 'bg-sky-500/15 text-sky-300',
  awaiting_human: 'bg-honey/15 text-honey',
  blocked: 'bg-coral/15 text-coral',
  completed: 'bg-sage/15 text-sage',
  failed: 'bg-coral/15 text-coral',
  cancelled: 'bg-ink/8 text-ink-soft',
}

/** Folyamat-LÉPÉS állapot → magyar címke (feladat- és folyamat-részletek). */
export const PROCESS_STEP_STATUS_LABELS: Record<string, string> = {
  pending: 'Következik',
  ready: 'Indítható',
  in_progress: 'Folyamatban',
  awaiting_gate: 'Jóváhagyásra vár',
  completed: 'Kész',
  skipped: 'Kihagyva',
  failed: 'Sikertelen',
}
