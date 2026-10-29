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
