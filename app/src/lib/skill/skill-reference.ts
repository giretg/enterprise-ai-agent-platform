/**
 * Skill-hivatkozás felismerés és szerzői (Playbook-author) skill-kontextus.
 *
 * A Playbook-szerző agent nem tool-loopban dolgozik (egyetlen strukturált hívás),
 * ezért a chat `load_skill` útja itt nem járható. Helyette ugyanazt a KÉT SZINTET
 * adjuk neki, csak előre feloldva:
 *  - Level-0: a tenantból olvasható skillek `name + description` indexe MINDIG a
 *    promptban — ebből tudja, hogy egyáltalán létezik-e ilyen munkamenet-leírás;
 *  - Level-1: ha a folyamat-leírás (vagy a szerkesztett spec) HIVATKOZIK egy
 *    skillre, annak a teljes törzse is bekerül — különben a szerző olyan lépést
 *    írna, ami a skill tényleges bemenetéhez/kimenetéhez nem illeszkedik.
 *
 * A modul tiszta (DB-mentes), így determinisztikusan tesztelhető.
 */
import type { SkillParameter } from '@/lib/skill/skill-content'
import { parseSkillSlashCommands } from '@/lib/skill/skill-slash-command'

/** Egy olvasható skill aktív verziójának szerzői vetülete. */
export interface SkillReferenceEntry {
  skillId: string
  skillVersionId: string
  name: string
  displayName?: string | null
  description: string
  version: number
  /** A `requires` capability-manifeszt tool-nevei — ezek kellenek a futtató agentnek. */
  requiredTools: string[]
  triggerKeywords: string[]
  parameters: SkillParameter[]
  instructions: string[]
}

/** Egyszerre legfeljebb ennyi skill törzsét töltjük be (prompt-ökonómia). */
export const MAX_REFERENCED_SKILLS = 3
/** Egy betöltött skill törzsének karakter-kerete a szerzői promptban. */
export const MAX_REFERENCED_SKILL_BODY_CHARS = 8_000
/** Ennél rövidebb kulcsszóra nem illesztünk (zajszűrés: „lap", „crm", „ár"). */
const MIN_TERM_LENGTH = 4
/**
 * Magyar toldalék-tűrés: „tulajdoni lapot", „földhivatali kivonatot", „skillt".
 * Ragozó nyelvben a szigorú szóhatár a hivatkozások többségét elvétené. A keret
 * szűk (3 karakter), hogy a toldalék ne csússzon át összetett/másik szóba
 * („lead" ≠ „leadership").
 */
const MAX_SUFFIX_CHARS = 3

/**
 * Ékezet- és írásjel-független alak. A felhasználó „tulajdoni-lap", „Tulajdoni lap"
 * és „tulajdoni lap ellenorzese" formában is hivatkozhat ugyanarra a skillre.
 */
function normalize(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `
}

/** Egy skill összes hivatkozási alakja, erősorrendben (név → megjelenített név → kulcsszó). */
function referenceTerms(entry: SkillReferenceEntry): string[] {
  const terms = [entry.name, entry.displayName ?? '', ...entry.triggerKeywords]
  const seen = new Set<string>()
  const result: string[] = []
  for (const term of terms) {
    const normalized = normalize(term).trim()
    if (normalized.length < MIN_TERM_LENGTH || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/**
 * Szóhatáros illesztés rövid toldalék-tűréssel. A `term` és a `haystack` is
 * normalizált (csak [a-z0-9] és szóköz), ezért regex-escape nem kell.
 * -1, ha nincs találat.
 */
function matchPosition(haystack: string, term: string): number {
  const match = new RegExp(` ${term}[a-z0-9]{0,${MAX_SUFFIX_CHARS}} `).exec(haystack)
  return match ? match.index : -1
}

/**
 * A folyamat-leírásban (és a szerkesztett specben) hivatkozott skillek kiválasztása.
 * A találat SZÓHATÁRON illeszkedik, így a „lead" nem húzza be a „leadership"-et.
 * Erősorrend: a skill neve/megjelenített neve előbbre való, mint egy trigger-kulcsszó;
 * azonos erősségnél a szövegben korábban felbukkanó nyer.
 */
export function detectReferencedSkills(
  text: string,
  catalog: SkillReferenceEntry[],
  limit = MAX_REFERENCED_SKILLS,
): SkillReferenceEntry[] {
  if (!text.trim() || catalog.length === 0) return []
  const haystack = normalize(text)

  const scored: { entry: SkillReferenceEntry; rank: number; position: number }[] = []
  for (const entry of catalog) {
    const terms = referenceTerms(entry)
    let bestRank = Number.POSITIVE_INFINITY
    let bestPosition = Number.POSITIVE_INFINITY
    for (let index = 0; index < terms.length; index++) {
      const position = matchPosition(haystack, terms[index])
      if (position < 0) continue
      // A név/displayName (index 0-1) erősebb jel, mint egy trigger-kulcsszó.
      const rank = index <= 1 ? 0 : 1
      if (rank < bestRank || (rank === bestRank && position < bestPosition)) {
        bestRank = rank
        bestPosition = position
      }
    }
    if (Number.isFinite(bestRank)) scored.push({ entry, rank: bestRank, position: bestPosition })
  }

  scored.sort((a, b) => a.rank - b.rank || a.position - b.position)
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry)
}

/**
 * A promptban hivatkozott skillek végleges listája: az EXPLICIT `/token`
 * választás (a `/` menüből vagy kézzel) mindig érvényesül és sosem esik ki a
 * keretből; utána egészítjük ki a szövegből felismert skillekkel.
 *
 * A token-feloldás ugyanaz a `parseSkillSlashCommands`, amit a chat használ —
 * a felhasználó ugyanazt a `/` jelentést kapja mindkét felületen.
 */
export function resolveReferencedSkills(
  text: string,
  catalog: SkillReferenceEntry[],
  limit = MAX_REFERENCED_SKILLS,
): SkillReferenceEntry[] {
  if (catalog.length === 0) return []
  const byId = new Map(catalog.map((e) => [e.skillVersionId, e]))
  const picked: SkillReferenceEntry[] = []
  const seen = new Set<string>()

  for (const id of parseSkillSlashCommands(text, catalog).skillVersionIds) {
    const entry = byId.get(id)
    if (!entry || seen.has(id)) continue
    seen.add(id)
    picked.push(entry)
  }
  for (const entry of detectReferencedSkills(text, catalog, limit)) {
    if (seen.has(entry.skillVersionId) || picked.length >= Math.max(limit, seen.size)) continue
    seen.add(entry.skillVersionId)
    picked.push(entry)
  }
  return picked
}

/**
 * Level-0 katalógus-blokk. Üres katalógusnál üres string — a hívó ilyenkor NEM
 * injektál üzenetet (ne tanítsuk a modellt egy nem létező szótárra).
 */
export function buildSkillCatalogPrompt(catalog: SkillReferenceEntry[]): string {
  if (catalog.length === 0) return ''
  const lines = catalog.map((e) => {
    const label = e.displayName && e.displayName !== e.name ? `${e.name} („${e.displayName}")` : e.name
    const tools = e.requiredTools.length > 0 ? ` [required tools: ${e.requiredTools.join(', ')}]` : ''
    return `- ${label} (v${e.version}) — ${e.description}${tools}`
  })
  return [
    'SKILL CATALOG available to this tenant (approved, versioned working procedures an executing agent can load at runtime).',
    'A skill is NOT a capability and NOT a step: it is written guidance. Refer to a skill by its name; never invent one that is not on this list.',
    '',
    ...lines,
  ].join('\n')
}

/** Level-1 törzs egy hivatkozott skillhez (a teljes instrukció, kerettel). */
export function buildReferencedSkillPrompt(entry: SkillReferenceEntry): string {
  const body = entry.instructions.join('\n\n')
  const truncated =
    body.length > MAX_REFERENCED_SKILL_BODY_CHARS
      ? `${body.slice(0, MAX_REFERENCED_SKILL_BODY_CHARS)}\n…[a skill törzse itt levágva]`
      : body
  const tools =
    entry.requiredTools.length > 0
      ? `Required tools (the executing agent MUST have these — put them in the assigned agent_role's requiredCapabilities): ${entry.requiredTools.join(', ')}`
      : 'Required tools: none declared.'
  const parameters =
    entry.parameters.length > 0
      ? `Declared skill parameters (natural inputSlots for the step that uses this skill):\n${entry.parameters
          .map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`)
          .join('\n')}`
      : 'Declared skill parameters: none.'
  return [
    `SKILL IN USE — "${entry.name}" (v${entry.version}). The request refers to it, so its full text is given below. Design the affected step(s) to be consistent with it.`,
    tools,
    parameters,
    `--- skill instructions: ${entry.name} v${entry.version} ---`,
    truncated,
    '--- end of skill ---',
  ].join('\n\n')
}
