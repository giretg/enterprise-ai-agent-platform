import type { ProcessStatus } from '@prisma/client'

/** Állapotok, amelyekből a ProcessService.advance még tovább-léptethet. */
export const ADVANCEABLE_PROCESS_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'created',
  'running',
  'awaiting_human',
])

/** Terminális / nem advanceable futás-állapotok (dispatcher skip). */
export const TERMINAL_PROCESS_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'blocked',
])
