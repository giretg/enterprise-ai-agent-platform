/**
 * Az `x-agent-version` gateway-fejléc biztonságos értelmezése.
 *
 * A fejléc kliens-vezérelt, nem megbízható bemenet. A nyers `Number.parseInt`
 * `NaN`-t ad nem-numerikus értékre (pl. `"abc"`), a `NaN ?? fallback` pedig
 * NEM esik vissza a fallbackre (a `NaN` nem nullish), így a `NaN` továbbfolyt
 * a modellhívásba és a `model_calls` / audit `Int` oszlopába. A Prisma a `NaN`-t
 * elutasítja — ám a fizetős providerhívás EKKOR MÁR lefutott, tehát a hívás
 * költsége nem könyvelődik a per-ticket call-cap, a keret-aggregátum és az
 * auditnapló felé (néma költség- és audit-rés), a hívó pedig 502-t kap.
 *
 * Ezért a határon validálunk: csak nemnegatív egészt fogadunk el, minden mást
 * `undefined`-ként adunk vissza — így a hívó a `?? agent.currentVersion`
 * fallbackre esik.
 *
 * Nem a `readPositiveInt`-et használjuk: az fallback-értéket ad (nem `undefined`-et,
 * amiből a hívó `??`-ja döntene), és a `0`-t is eldobja — a verzió `0` viszont
 * érvényes. A `parseInt` szándékosan csonkol (`"3abc" → 3`): a lényeg, hogy `NaN`
 * sose keletkezzen; a `3` érvényes egész, nem nyit költség-/audit-rést.
 */
export function parseAgentVersionHeader(raw: string | null | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}
