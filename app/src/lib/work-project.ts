export const GENERAL_WORK_PROJECT_KEY = '__general__'
export const GENERAL_WORK_PROJECT_NAME = 'Általános'

const HUNGARIAN_FOLD: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ö: 'o',
  ő: 'o',
  ú: 'u',
  ü: 'u',
  ű: 'u',
  Á: 'a',
  É: 'e',
  Í: 'i',
  Ó: 'o',
  Ö: 'o',
  Ő: 'o',
  Ú: 'u',
  Ü: 'u',
  Ű: 'u',
}

const KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/

export function isReservedWorkProjectKey(key: string): boolean {
  return key.trim() === GENERAL_WORK_PROJECT_KEY
}

export function isValidProjectKey(key: string): boolean {
  return KEY_RE.test(key)
}

export function slugifyWorkProjectKey(name: string): string {
  const folded = name.replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (ch) => HUNGARIAN_FOLD[ch] ?? ch)
  return folded
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.:-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^[._:-]+|[._:-]+$/g, '')
    .slice(0, 120)
}

export function effectiveWorkProjectKey(raw: string | null | undefined): string {
  const key = (raw ?? '').trim()
  return key || GENERAL_WORK_PROJECT_KEY
}

export function normalizeNamedProjectKey(raw: string): string | null {
  const key = raw.trim()
  if (!key || isReservedWorkProjectKey(key) || !isValidProjectKey(key)) return null
  return key
}

/** Relative UTF-8 path under the project prefix. No `..`, no absolute, no leading slash. */
export function normalizeWorkFilePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.startsWith('/') || trimmed.length > 240) return null
  const parts = trimmed.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..' || part === '~')) return null
  return parts.join('/')
}
