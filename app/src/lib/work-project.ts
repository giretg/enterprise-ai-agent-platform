import { isValidProjectKey } from '@/domain/channel/channel-types'

export const GENERAL_WORK_PROJECT_KEY = '__general__'
export const GENERAL_WORK_PROJECT_NAME = 'Általános'
export const GENERAL_WORK_PROJECT_DESCRIPTION =
  'Minden, amihez nincs külön projekt rendelve. Több beszélgetés és munkatárs is ide kerülhet.'

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

export function isReservedWorkProjectKey(key: string): boolean {
  return key.trim() === GENERAL_WORK_PROJECT_KEY
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

export function normalizeWorkProjectKey(raw: string): string | null {
  const key = raw.trim()
  if (!key || isReservedWorkProjectKey(key) || !isValidProjectKey(key)) return null
  return key
}

export function effectiveWorkProjectKey(raw: string | null | undefined): string {
  const key = (raw ?? '').trim()
  return key || GENERAL_WORK_PROJECT_KEY
}

export function assignableWorkProjectOptions(
  projects: Array<{ key: string; name: string; archived?: boolean }>,
): Array<{ key: string; name: string }> {
  return projects
    .filter((project) => project.archived !== true)
    .map((project) => ({ key: project.key, name: project.name }))
}
