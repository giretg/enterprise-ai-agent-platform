/**
 * Feladatkör-korlátozás (#199) — a korlátozott agenthez tartozó ticket
 * SZERVEROLDALON generált szövegei.
 *
 * A kliens sem címet, sem szabad szöveges leírást nem küldhet: a felület egyetlen
 * gombra egyszerűsödik, a bemenetet a skill deklarált paraméterei és — ha a skill
 * engedi — a csatolt fájlok adják. Ez a modul tiszta (DB- és időzóna-mentesen
 * paraméterezett), így determinisztikusan tesztelhető.
 */

/** A platform megjelenítési időzónája. Tenant-szintű időzóna ma nincs a modellben. */
export const TASK_ONLY_TITLE_TIME_ZONE = 'Europe/Budapest'

/**
 * `<megjelenített név | technikai név> — YYYY-MM-DD HH:mm`.
 * A hívó tipikusan `skillDisplayLabel(...)`-t ad át. A `sv-SE` locale pont ezt az
 * ISO-szerű alakot adja, így nem kell kézzel nulláznunk a mezőket.
 */
export function buildTaskOnlyTicketTitle(
  skillLabel: string,
  now: Date,
  timeZone: string = TASK_ONLY_TITLE_TIME_ZONE,
): string {
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(now)
    // A `sv-SE` „2026-08-01 14:03" alakot ad, de a futtatókörnyezettől függően
    // keskeny nem-törő szóköz kerülhet a dátum és az idő közé — normalizáljuk.
    .replace(/\s+/g, ' ')
  return `${skillLabel.trim()} — ${stamp}`
}

/**
 * A ticketre explicit kért skill-verziók a tárolt payloadból. A csatolmány-kapu
 * (#199) ebből dönt a workspace-feltöltő endpointon, ezért fail-safe olvasás:
 * hibás alak → üres lista (nincs skill, nincs tiltás).
 */
export function readTicketPreferredSkillVersionIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const raw = (payload as Record<string, unknown>).preferredSkillVersionIds
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

export type TaskOnlyValidation =
  | { ok: true; parameterValues: Record<string, string> }
  | { ok: false; error: string }

/**
 * A korlátozott feladatkörű agent feladat-bemenetének ellenőrzése.
 *
 * Tiszta függvény, hogy a szabály egy helyen éljen és tesztelhető legyen. A hibát
 * mindenütt KIMONDJUK: a csendes eldobás azt a hamis képet adná a hívónak, hogy a
 * leírása vagy a paramétere eljutott a modellhez.
 */
export function validateTaskOnlyTaskInput(input: {
  description?: string | null
  skillVersionIds: string[]
  skillParameterValues?: Record<string, string> | null
  /** A kiválasztott skill `parameters[]` nevei — csak ezek fogadhatók el kulcsként. */
  declaredParameterNames: string[]
}): TaskOnlyValidation {
  if (input.description?.trim()) {
    return {
      ok: false,
      error: 'A korlátozott feladatkörű agent nem fogad szabad szöveges feladatleírást',
    }
  }
  if (input.skillVersionIds.length !== 1) {
    return {
      ok: false,
      error: 'A korlátozott feladatkörű agentnek pontosan egy engedélyezett skillt kell megadni',
    }
  }
  const declared = new Set(input.declaredParameterNames)
  const parameterValues: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.skillParameterValues ?? {})) {
    if (!declared.has(key)) return { ok: false, error: `Ismeretlen skill-paraméter: ${key}` }
    // v1-ben minden paraméter opcionális: az üresen hagyott mező egyszerűen kimarad.
    if (value.trim()) parameterValues[key] = value.trim()
  }
  return { ok: true, parameterValues }
}

/**
 * A modellnek átadott feladat-szöveg. A generált CÍM nem válhat rejtett prompttá
 * (a `general-task-runtime` a cím-fallbackot használná), ezért determinisztikus,
 * értelmes utasítást írunk a payload `question` mezőjébe.
 */
export function buildTaskOnlyTaskPrompt(skillName: string): string {
  return [
    `Futtasd le a(z) "${skillName.trim()}" skillt. A skill teljes instrukciója be van töltve;`,
    'kövesd pontosan. Szabad szöveges feladatleírás nincs — a bemenetet a megadott',
    'paraméterek és a csatolt fájlok adják.',
  ].join(' ')
}

/**
 * A webes chat-stream kapuja (#199): korlátozott feladatkörű agentnél új forduló
 * tiltott — KIVÉVE a Ticket → Megbeszélés (#219) beszélgetést, ahol a ticket
 * előzményéről kell tudni beszélni.
 */
export function shouldBlockTaskOnlyWebChat(input: {
  taskOnly: boolean
  continuedFromTicketId?: string | null
}): boolean {
  if (!input.taskOnly) return false
  if (input.continuedFromTicketId) return false
  return true
}
