/** Hét napjával együtt, hogy az időpont ránézésre ellenőrizhető legyen: „csütörtök, 2026. nov. 5. 15:45”. */
export function formatRunTime(value: Date | string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'hu-HU', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatDateTime(value: Date | string | null | undefined, locale: string, timeZone?: string): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'hu-HU', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

/** Naptári nap (határidő): UTC szerint, hogy az időzóna ne tolja át a dátumot a következő napra. */
export function formatCalendarDate(value: Date | string, locale: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'hu-HU', { timeZone: 'UTC', dateStyle: 'medium' }).format(date)
}
