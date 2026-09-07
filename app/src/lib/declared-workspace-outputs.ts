/**
 * „A futás szerint elkészült fájlok" — a mért mellékhatásból (`ToolCall.effectSummary`).
 *
 * A háttér: az AI munkatárs válaszában azt írja, hogy elmentette a fájlt, a
 * Munkafájlok panel viszont üres. Eddig a felhasználónak kellett eldöntenie,
 * melyik állítás igaz. A tool-hívás mért mellékhatása (`target`) objektív
 * forrás: ha ott szerepel egy fájlnév, de a munkaterületen nincs meg, azt a
 * felület kimondja, nem elhallgatja.
 */

/** UUID-alakú célpont (pl. board_write ticketId) — nem fájl. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Fájlnévnek látszik: van kiterjesztése, és relatív útvonal. */
const FILE_LIKE_RE = /\.[a-z0-9]{1,8}$/i

export type EffectBearingCall = {
  toolName?: string | null
  effectSummary?: unknown
}

function readTarget(effectSummary: unknown): string | null {
  if (!effectSummary || typeof effectSummary !== 'object') return null
  const target = (effectSummary as Record<string, unknown>).target
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (!trimmed || trimmed.length > 512) return null
  if (trimmed.startsWith('/') || trimmed.includes('..')) return null
  if (UUID_RE.test(trimmed)) return null
  if (!FILE_LIKE_RE.test(trimmed)) return null
  return trimmed
}

/** A futás során előállítottként rögzített munkafájlok, sorrendtartóan, duplikátum nélkül. */
export function declaredWorkspaceOutputs(calls: EffectBearingCall[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const call of calls) {
    const target = readTarget(call.effectSummary)
    if (!target || seen.has(target)) continue
    seen.add(target)
    out.push(target)
  }
  return out
}

/** Amit a futás előállítottként rögzített, de a munkaterületen most nincs meg. */
export function missingDeclaredOutputs(declared: string[], presentFiles: string[]): string[] {
  const present = new Set(presentFiles)
  return declared.filter((path) => !present.has(path))
}
