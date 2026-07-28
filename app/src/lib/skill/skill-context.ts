import type { SkillContent } from './skill-content'

/**
 * Progresszív skill-betöltés context-assembler rétege (spec §D7, WP-5).
 *
 *  - Level-0 index: a hozzárendelt (enabled) skillek `name + description`-je
 *    MINDIG a promptban — de KIZÁRÓLAG ezek (D2 kemény input-kontroll). A nem
 *    hozzárendelt skill szövege sosem kerül a kontextusba; az agent nem tud róla.
 *  - Level-1: a teljes `instructions` egy explicit `load_skill` tool-hívással
 *    töltődik — brokerelt, deny-by-default, auditált ToolCall.
 *
 * Ez a modul tiszta (DB-mentes), így determinisztikusan tesztelhető.
 */

export interface AssignedSkillEntry {
  skillId: string
  skillVersionId: string
  name: string
  description: string
  version: number
}

/**
 * Level-0 index rendszer-üzenet szöveg. Ha nincs hozzárendelt skill, üres
 * stringet ad (a hívó ilyenkor NEM injektál üzenetet). A `load_skill` a
 * skillVersionId-t várja — ez a stabil, verzió-pinnelt azonosító.
 */
export function buildSkillIndexPrompt(entries: AssignedSkillEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(
    (e) => `- ${e.name} (id: ${e.skillVersionId}) — ${e.description}`,
  )
  return [
    'Elérhető skillek (készség-leírások). Ezek opcionális, előre jóváhagyott munkamenet-leírások.',
    'Ha egy feladathoz relevánsnak látsz egyet, a teljes instrukcióját a `load_skill` eszközzel töltsd be a lenti `id` (skillVersionId) megadásával. A skill szövege puha iránymutatás; a tényleges jogosultságokat továbbra is a Tool Broker dönti el.',
    '',
    ...lines,
  ].join('\n')
}

/**
 * Fail-closed feloldás a `load_skill` híváshoz: CSAK a ténylegesen hozzárendelt
 * (enabled) skill-verzió tölthető be. Ismeretlen/nem hozzárendelt id → null
 * (deny). A hívó ezt `skill.loaded` auditált ToolCall-ként kezeli.
 */
export function resolveLoadableSkill(
  entries: AssignedSkillEntry[],
  skillVersionId: string,
): AssignedSkillEntry | null {
  return entries.find((e) => e.skillVersionId === skillVersionId) ?? null
}

/** A betöltött skill Level-1 törzse (a `load_skill` eredménye a modell felé). */
export function buildLoadedSkillPrompt(
  entry: AssignedSkillEntry,
  content: SkillContent,
): string {
  const header = `# Skill: ${entry.name} (v${entry.version})`
  const keywords =
    content.triggerKeywords.length > 0
      ? `\nKulcsszavak: ${content.triggerKeywords.join(', ')}`
      : ''
  const hints = content.runtimeHints
  const hintLines: string[] = []
  if (hints?.maxWallClockMs != null) {
    hintLines.push(
      `Futási keret: legfeljebb ~${Math.round(hints.maxWallClockMs / 1000)} s erre a skillre (a platform ennyire emeli a forduló időkorlátját).`,
    )
  }
  if (hints?.maxToolCalls != null) {
    hintLines.push(`Eszközhívási keret (skill): legfeljebb ${hints.maxToolCalls} hívás.`)
  }
  if (hints?.preferredMode === 'task') {
    hintLines.push(
      'Ez tipikusan hosszabb feladat — ha a chat kerete szűknek bizonyul, ticket/aszinkron futás a természetes mód.',
    )
  }
  const hintBlock = hintLines.length > 0 ? `\n${hintLines.join('\n')}` : ''
  const body = content.instructions.join('\n\n')
  return `${header}${keywords}${hintBlock}\n\n${body}`.trim()
}
