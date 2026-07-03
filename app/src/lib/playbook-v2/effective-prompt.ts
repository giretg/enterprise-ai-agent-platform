/**
 * Effektív prompt összeállítása egy agent-lépéshez (Folyamat-feature-spec §4.7).
 *
 * A rétegzés B-út szerint: az utasítás a Playbook lépésén él (sablonként, tipizált
 * résekkel), a perszóna az agenten. Az effektív prompt:
 *
 *   agent-perszóna (additív)  +  lépés-utasítás (rések kitöltve)  +  futás-input
 *
 * Szabályok:
 *  - A perszónát NEM írjuk felül — pont azért választunk konkrét agentet, mert a
 *    tudás/eszköz/hozzáférés benne van. A perszóna szövege sértetlen marad.
 *  - A `{{slot}}` tokenek az összevont `slots` map-ből oldódnak fel: a `config`
 *    forrású rések a ProcessDefinition.configValues-ból, a `trigger` forrásúak a
 *    Futás inputPayload-jából (a hívó egyesíti őket ebbe a map-be).
 *  - Precedencia: tartalmi ütközésnél a lépés-utasítás mérvadó arra, hogy MIT
 *    csináljon; a perszóna az identitás/eszköz/stílus. A sorrend ezt tükrözi.
 *
 * Ez tiszta függvény (DB/LLM nélkül), hogy determinisztikusan tesztelhető legyen;
 * a dispatcher / agent-runtime fogyasztja.
 */

export type BuildEffectivePromptInput = {
  /** Az agent role_instruction + persona — NEM íródik felül. */
  agentPersona: string
  /** A lépés sablonos utasítása; a `{{slot}}`-ok innen kerülnek behelyettesítésre. */
  instructionTemplate?: string
  /** A config + trigger rések feloldott értékei (a hívó egyesíti). */
  slots?: Record<string, unknown>
  /** A futás-bemenet nyers, résekhez nem kötött része (opcionális kontextus). */
  runInput?: Record<string, unknown>
}

/** Egy `{{ slot }}` behelyettesítés eredménye a hiányzó rések nyomon követéséhez. */
export type EffectivePromptResult = {
  prompt: string
  /** A template-ben szereplő, de a `slots`-ban nem feloldott tokenek (üres, ha minden feloldott). */
  missingSlots: string[]
}

const SLOT_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

/** Egy értéket promptba illeszthető stringgé alakít (objektum → kanonikus JSON). */
function stringifyValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** A `{{slot}}` tokeneket behelyettesíti; a feloldatlanokat változatlanul hagyja és jelzi. */
function fillTemplate(
  template: string,
  slots: Record<string, unknown>,
): { text: string; missing: string[] } {
  const missing = new Set<string>()
  const text = template.replace(SLOT_TOKEN_RE, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(slots, name) && slots[name] != null) {
      return stringifyValue(slots[name])
    }
    missing.add(name)
    return match
  })
  return { text, missing: [...missing] }
}

/**
 * Összeállítja az effektív promptot a §4.7 rétegzés szerint. A visszaadott
 * `missingSlots` a template feloldatlan tokenjeit sorolja (a hívó dönt: blokk vagy
 * folytatás — a runtime a kötelező trigger-résekre §4.5 szerint blokkol).
 */
export function buildEffectivePrompt(input: BuildEffectivePromptInput): EffectivePromptResult {
  const slots = input.slots ?? {}
  const sections: string[] = []

  // 1. Perszóna (additív, sértetlen).
  const persona = input.agentPersona.trim()
  if (persona) sections.push(persona)

  // 2. Lépés-utasítás (rések kitöltve) — mérvadó a feladatra.
  let missingSlots: string[] = []
  const template = input.instructionTemplate?.trim()
  if (template) {
    const filled = fillTemplate(template, slots)
    missingSlots = filled.missing
    sections.push(filled.text)
  }

  // 3. Futás-input (nyers kontextus), ha van érdemi tartalom.
  if (input.runInput && Object.keys(input.runInput).length > 0) {
    sections.push(`Futás-bemenet:\n${stringifyValue(input.runInput)}`)
  }

  return { prompt: sections.join('\n\n'), missingSlots }
}
