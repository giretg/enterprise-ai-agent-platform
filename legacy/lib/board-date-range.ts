const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/

/** Lokális naptári nap YYYY-MM-DD formában (date input érték). */
export function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Alap board-intervallum: mai nap visszamenőleg egy hónap. */
export function defaultBoardDateRange(now = new Date()): { from: string; to: string } {
  const to = formatDateInput(now)
  const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
  return { from: formatDateInput(fromDate), to }
}

export function isDateInputValue(value: string | undefined | null): value is string {
  if (!value || !DATE_INPUT_RE.test(value)) return false
  const parsed = parseDateInputStart(value)
  return !Number.isNaN(parsed.getTime())
}

/** A nap kezdete helyi időben. */
export function parseDateInputStart(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0)
}

/** A nap vége helyi időben (inklúzív felső határ). */
export function parseDateInputEnd(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999)
}

/**
 * Board URL / űrlap dátumok normalizálása.
 * Érvénytelen vagy hiányzó érték → alapértelmezett egy hónap.
 * Ha a -tól későbbi, mint a -ig, megcseréljük.
 */
export function resolveBoardDateRange(input?: {
  from?: string | null
  to?: string | null
}): { from: string; to: string; updatedAtGte: Date; updatedAtLte: Date } {
  const defaults = defaultBoardDateRange()
  let from = isDateInputValue(input?.from) ? input.from : defaults.from
  let to = isDateInputValue(input?.to) ? input.to : defaults.to
  if (from > to) {
    const swap = from
    from = to
    to = swap
  }
  return {
    from,
    to,
    updatedAtGte: parseDateInputStart(from),
    updatedAtLte: parseDateInputEnd(to),
  }
}
