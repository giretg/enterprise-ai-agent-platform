/** Skill-név normalizálás és hatókörön belüli egyediség (case-insensitive, trim). */

export function normalizeSkillName(name: string): string {
  return name.trim()
}

export function skillNamesEqual(a: string, b: string): boolean {
  return normalizeSkillName(a).toLowerCase() === normalizeSkillName(b).toLowerCase()
}
