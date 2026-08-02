import type { SkillContent, SkillParameter } from './skill-content'

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
  // A skill DEKLARÁLT paraméterei (#199). Enélkül a `parameters` sosem jutott
  // promptig: tárolódott és diffelődött, de a modell nem tudott róla, így a
  // feladat-indításkor kitöltött értékeket sem tudta hova kötni.
  const paramBlock =
    content.parameters.length > 0
      ? `\n\nA skill paraméterei (a feladat indítója tölti ki, mindegyik opcionális):\n${content.parameters
          .map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`)
          .join('\n')}`
      : ''
  const body = content.instructions.join('\n\n')
  return `${header}${keywords}${hintBlock}${paramBlock}\n\n${body}`.trim()
}

/**
 * A feladat indításakor kitöltött skill-paraméter-ÉRTÉKEK prompt-blokkja (#199).
 * Csak a ténylegesen kitöltött mezők kerülnek bele (v1-ben minden paraméter
 * opcionális), és a paraméter leírása is megy vele, hogy a modell tudja, mit
 * jelent az érték. Üres eredmény → a hívó ne injektáljon üzenetet.
 */
export function formatSkillParameterValuesPrompt(
  parameters: SkillParameter[],
  values: Record<string, string>,
): string {
  const lines: string[] = []
  for (const param of parameters) {
    const raw = values[param.name]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const label = param.description ? `${param.name} (${param.description})` : param.name
    lines.push(`- ${label}: ${raw.trim()}`)
  }
  if (lines.length === 0) return ''
  return [
    'Skill-paraméterek (a feladat indítója adta meg — ezek a feladat bemenetei):',
    ...lines,
  ].join('\n')
}
