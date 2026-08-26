/**
 * A publikus, OpenAI-kompatibilis gateway végpont
 * (`/api/v1/gateway/v1/chat/completions`) a hívó agent-kliensétől két opcionális
 * kontextust kap HTTP-fejlécben: `x-agent-version` és `x-ticket-id`. Ezek NEM
 * megbízhatók — a kliens tetszőleges stringet küldhet.
 *
 * A lefelé menő `ModelCall` költség-rekord viszont tipizált oszlopokba ír:
 * `agent_version Int?`, `ticket_id @db.Uuid` (idegen kulcs a `Ticket`-re). Egy
 * rosszul formázott fejléc ezért NEM a kérés elején bukna el, hanem a rekord
 * PERZISZTÁLÁSAKOR — MIUTÁN a modellhívás (és a szolgáltatói költség) már
 * megtörtént. A hívás így a keret- és audit-nyilvántartásból láthatatlanul esne
 * ki: a platform fizet a szolgáltatónak, de a költség nem számítódik a keretbe és
 * nem jelenik meg a riportokban.
 *
 * Ez a modul a fejléceket a TÁROLHATÓ tartományra szűri, fail-safe módon: egy
 * érvénytelen érték `undefined` lesz (a hívás lefut és rögzül, csak a hibás
 * kontextus esik ki), nem pedig a teljes rekordot megbuktató szemét.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `x-agent-version` → nemnegatív egész, vagy `undefined`.
 *
 * A `Number.parseInt('abc', 10)` `NaN`-t ad, amit a hívó `?? agent.currentVersion`
 * fallbackje NEM fog el (a `??` csak `null`/`undefined`-ra vált). A `NaN` így
 * átcsúszna a gateway-be és egy `Int` oszlopba írva megbuktatná a rekordot. Ezért
 * itt a nem tisztán számjegy alakú fejléc SZÁNDÉKOSAN `undefined`-dá esik.
 */
export function parseAgentVersionHeader(raw: string | null | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined
  const value = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * `x-ticket-id` → jól formázott UUID string, vagy `undefined`.
 *
 * Csak a FORMÁTUMOT garantálja (a `@db.Uuid` oszlop-invariáns). A tenant-kötést
 * (a ticket a hívó agent szervezetéhez tartozik-e) a hívó route végzi, mert az
 * adatbázis-hozzáférést igényel.
 */
export function parseTicketIdHeader(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || !UUID_RE.test(trimmed)) return undefined
  return trimmed
}
