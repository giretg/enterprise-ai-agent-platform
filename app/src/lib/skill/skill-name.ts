/** Skill-név normalizálás és hatókörön belüli egyediség (case-insensitive, trim). */

export function normalizeSkillName(name: string): string {
  return name.trim()
}

export function skillNamesEqual(a: string, b: string): boolean {
  return normalizeSkillName(a).toLowerCase() === normalizeSkillName(b).toLowerCase()
}

/**
 * Embernek szóló címke a feladatválasztóban / modálban / ticket címen.
 * Üres `displayName` → technikai `name` (slug).
 */
export function skillDisplayLabel(skill: {
  name: string
  displayName?: string | null
}): string {
  const label = skill.displayName?.trim()
  return label || skill.name
}

/** Üres string → null; egyébként trimelt displayName. */
export function normalizeSkillDisplayName(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
