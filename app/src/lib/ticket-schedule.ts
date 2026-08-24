/**
 * Ütemezett feladatok megjelenítése és payload-lenyomata.
 *
 * A dispatcher két úton indít időzített munkát:
 * 1. `ticket.executeAfter` — egyszeri, jövőbeli ready ticket (`scheduled_later` skip).
 * 2. `ScheduledTask` — ismétlődő (és a chatből jövő one-shot) feladatok; a worker
 *    `materializeDue` a következő előfordulást ticketként a táblára teszi.
 *
 * Rendszeres feladatnál a táblán lévő eredeti ticket a **sorozat** (`role: series`):
 * nem dispatchelődik, a következő időpontot mutatja. Futáskor új **példány**
 * (`role: occurrence`) készül az akkori dátummal — ez megy készbe.
 *
 * A boardon a kártya és a részletek a payload `schedule` / `scheduledRun`
 * mezőiből + `executeAfter`-ből olvassák az ütemezést.
 */

export const TICKET_SCHEDULE_RECURRENCES = ['hourly', 'daily', 'weekly', 'monthly'] as const
export type TicketScheduleRecurrence = (typeof TICKET_SCHEDULE_RECURRENCES)[number]
export type TicketScheduleKind = 'once' | 'recurring'
export type TicketScheduleRole = 'series' | 'occurrence'

export const TICKET_SCHEDULE_RECURRENCE_LABELS: Record<TicketScheduleRecurrence, string> = {
  hourly: 'óránként',
  daily: 'naponta',
  weekly: 'hetente',
  monthly: 'havonta',
}

export type TicketScheduleStamp = {
  kind: TicketScheduleKind
  recurrence: TicketScheduleRecurrence | 'none'
  runAt: string
  intervalHours?: number
  maxRuns?: number | null
  role?: TicketScheduleRole
}

export type TicketScheduleView = {
  kind: TicketScheduleKind
  recurrence: TicketScheduleRecurrence | 'none'
  runAt: Date
  intervalHours: number | null
  maxRuns: number | null
  scheduledTaskId: string | null
  role?: TicketScheduleRole
  pending: boolean
  label: string
  compactLabel: string
}

const MIN_INTERVAL_HOURS = 1
const MAX_INTERVAL_HOURS = 168

export function isTicketScheduleRecurrence(value: unknown): value is TicketScheduleRecurrence {
  return (
    value === 'hourly' || value === 'daily' || value === 'weekly' || value === 'monthly'
  )
}

export function clampIntervalHours(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.floor(value)))
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

function parseIsoDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatScheduleDateTime(value: Date | string): string {
  return new Date(value).toLocaleString('hu-HU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function recurrenceCaption(
  recurrence: TicketScheduleRecurrence | 'none',
  intervalHours?: number | null,
): string {
  if (recurrence === 'none') return 'egyszer'
  if (recurrence === 'hourly') {
    const hours = clampIntervalHours(intervalHours ?? 1)
    return hours === 1 ? 'óránként' : `minden ${hours}. órában`
  }
  return TICKET_SCHEDULE_RECURRENCE_LABELS[recurrence]
}

export function buildTicketScheduleStamp(input: {
  kind: TicketScheduleKind
  runAt: Date
  recurrence?: TicketScheduleRecurrence | 'none'
  intervalHours?: number | null
  maxRuns?: number | null
  role?: TicketScheduleRole
}): TicketScheduleStamp {
  const stamp: TicketScheduleStamp = {
    kind: input.kind,
    recurrence: input.kind === 'recurring' ? (input.recurrence ?? 'daily') : 'none',
    runAt: input.runAt.toISOString(),
  }
  if (stamp.recurrence === 'hourly') {
    stamp.intervalHours = clampIntervalHours(input.intervalHours ?? 1)
  }
  if (input.kind === 'recurring' && input.maxRuns != null) {
    stamp.maxRuns = input.maxRuns
  }
  if (input.role) stamp.role = input.role
  return stamp
}

export function stampTicketSchedule(
  payload: Record<string, unknown>,
  schedule: TicketScheduleStamp,
  extra?: {
    scheduledTaskId?: string | null
    role?: TicketScheduleRole
    seriesTicketId?: string | null
  },
): Record<string, unknown> {
  const role = extra?.role ?? schedule.role
  const stamped: TicketScheduleStamp = role ? { ...schedule, role } : { ...schedule }
  const next: Record<string, unknown> = {
    ...payload,
    scheduledRun: true,
    schedule: stamped,
    ...(extra?.scheduledTaskId ? { scheduledTaskId: extra.scheduledTaskId } : {}),
    ...(stamped.intervalHours ? { intervalHours: stamped.intervalHours } : {}),
  }
  if (role === 'series') {
    next.scheduleSeries = true
    delete next.scheduleOccurrence
  } else if (role === 'occurrence') {
    delete next.scheduleSeries
    next.scheduleOccurrence = true
    if (extra?.seriesTicketId) next.seriesTicketId = extra.seriesTicketId
  }
  return next
}

function readStamp(payload: Record<string, unknown> | null): TicketScheduleStamp | null {
  if (!payload) return null
  const raw = payload.schedule
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const kind = record.kind === 'recurring' ? 'recurring' : record.kind === 'once' ? 'once' : null
  if (!kind) return null
  const runAt = typeof record.runAt === 'string' ? record.runAt : null
  if (!runAt) return null
  const recurrence = isTicketScheduleRecurrence(record.recurrence)
    ? record.recurrence
    : 'none'
  const intervalHours =
    typeof record.intervalHours === 'number' ? clampIntervalHours(record.intervalHours) : undefined
  const maxRuns =
    typeof record.maxRuns === 'number' && Number.isInteger(record.maxRuns) ? record.maxRuns : null
  const role =
    record.role === 'series' || record.role === 'occurrence' ? record.role : undefined
  return {
    kind,
    recurrence: kind === 'recurring' ? recurrence : 'none',
    runAt,
    ...(intervalHours ? { intervalHours } : {}),
    ...(maxRuns != null ? { maxRuns } : {}),
    ...(role ? { role } : {}),
  }
}

export function isScheduledTicket(input: {
  executeAfter?: Date | string | null
  payload?: unknown
}): boolean {
  if (input.executeAfter) {
    const date = parseIsoDate(input.executeAfter)
    if (date) return true
  }
  const payload = payloadRecord(input.payload)
  if (!payload) return false
  if (payload.scheduledRun === true) return true
  if (typeof payload.scheduledTaskId === 'string' && payload.scheduledTaskId.trim()) return true
  return readStamp(payload) !== null
}

export function isScheduleSeriesTicket(input: { payload?: unknown }): boolean {
  const payload = payloadRecord(input.payload)
  if (!payload) return false
  if (payload.scheduleSeries === true) return true
  return readStamp(payload)?.role === 'series'
}

export function occurrenceTitle(baseTitle: string, at: Date): string {
  return `${baseTitle} — ${formatScheduleDateTime(at)}`
}

function buildLabels(view: Omit<TicketScheduleView, 'label' | 'compactLabel'>): {
  label: string
  compactLabel: string
} {
  const when = formatScheduleDateTime(view.runAt)
  const cadence = recurrenceCaption(view.recurrence, view.intervalHours)
  if (view.role === 'occurrence') {
    return {
      label: `Futás · ${when}`,
      compactLabel: `Futás · ${when}`,
    }
  }
  if (view.kind === 'once') {
    return {
      label: view.pending ? `Ütemezve: ${when}` : `Ütemezett futás: ${when}`,
      compactLabel: view.pending ? `Ütemezve · ${when}` : `Ütemezett · ${when}`,
    }
  }
  if (view.role === 'series') {
    return {
      label: view.pending
        ? `Rendszeres (${cadence}) · következő: ${when}`
        : `Rendszeres (${cadence}) · véget ért`,
      compactLabel: view.pending ? `Következő · ${when}` : `Sorozat · véget ért`,
    }
  }
  const next = view.pending ? `következő: ${when}` : `utóbbi: ${when}`
  return {
    label: `Rendszeres (${cadence}) · ${next}`,
    compactLabel: `${cadence} · ${when}`,
  }
}

export function readTicketSchedule(
  payload: unknown,
  executeAfter?: Date | string | null,
  now: Date = new Date(),
): TicketScheduleView | null {
  const record = payloadRecord(payload)
  const stamp = readStamp(record)
  const executeAt = parseIsoDate(executeAfter)
  const runAt =
    (stamp ? parseIsoDate(stamp.runAt) : null) ??
    executeAt ??
    (typeof record?.scheduledTaskId === 'string' ? executeAt : null)

  const scheduled =
    Boolean(stamp) ||
    Boolean(executeAt) ||
    record?.scheduledRun === true ||
    typeof record?.scheduledTaskId === 'string'

  if (!scheduled || !runAt) {
    if (!executeAt) return null
  }

  const at = runAt ?? executeAt
  if (!at) return null

  const recurrence = stamp?.recurrence
    ?? (isTicketScheduleRecurrence(record?.recurrence) ? record.recurrence : 'none')
  const kind: TicketScheduleKind =
    stamp?.kind ?? (recurrence !== 'none' ? 'recurring' : 'once')
  const intervalHours =
    stamp?.intervalHours ??
    (typeof record?.intervalHours === 'number' ? clampIntervalHours(record.intervalHours) : null)
  const scheduledTaskId =
    typeof record?.scheduledTaskId === 'string' ? record.scheduledTaskId : null
  const role: TicketScheduleRole | undefined =
    stamp?.role ??
    (record?.scheduleSeries === true
      ? 'series'
      : record?.scheduleOccurrence === true
        ? 'occurrence'
        : undefined)

  const view = {
    kind,
    recurrence: kind === 'recurring' ? recurrence : 'none',
    runAt: at,
    intervalHours: kind === 'recurring' && recurrence === 'hourly' ? intervalHours ?? 1 : null,
    maxRuns: stamp?.maxRuns ?? null,
    scheduledTaskId,
    role,
    pending: at.getTime() > now.getTime(),
  }
  return { ...view, ...buildLabels(view) }
}

/** `datetime-local` mező → ISO (a böngésző helyi idejében értelmezve). */
export function localDateTimeToIso(value: string): string | null {
  if (!value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function defaultScheduleLocalDateTime(hoursAhead = 1): string {
  return toDatetimeLocalValue(new Date(Date.now() + hoursAhead * 3600_000))
}
