/**
 * Kimenő üzenet darabolása (Telegram feature-spec #70/#74, story 21 / AC „hosszú válasz").
 *
 * A Telegram egy üzenet hosszát ~4096 karakterben maximálja. Egy hosszú agent-válasznak
 * ezért TÖBB, ÖNMAGÁBAN ÉRVÉNYES, SORRENDHELYES darabra kell bomlania. A darabolás
 * határon (bekezdés → sor → szó → végső kényszervágás) próbál vágni, hogy a darabok
 * olvashatók maradjanak, és sosem vág egy több-bájtos karakter közepébe (kód-pontokkal
 * dolgozik).
 *
 * A darabolás UTÁN kerül rá a címke-prefix (a hívó dolga), ezért a `limit` a címkével
 * csökkentett hasznos hossz kell legyen — így a felcímkézett darab is a Telegram-korlát
 * alatt marad.
 */

/** A Telegram üzenet-hosszkorlát (karakter). */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096

/**
 * Egy szöveget legfeljebb `limit` kódpont hosszú, sorrendhelyes darabokra bont. Üres/csupa
 * whitespace bemenetre egyetlen üres darabot ad vissza a hívónak nincs külön ága rá).
 */
export function chunkOutboundText(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('chunk limit must be positive')
  const normalized = text.replace(/\r\n/g, '\n')
  const codepoints = [...normalized]
  if (codepoints.length <= limit) {
    const trimmed = normalized.trim()
    return [trimmed.length > 0 ? trimmed : normalized]
  }

  const chunks: string[] = []
  let rest = normalized
  while ([...rest].length > limit) {
    const window = [...rest].slice(0, limit)
    const windowStr = window.join('')
    const cut = bestCutIndex(windowStr, limit)
    const head = [...rest].slice(0, cut).join('').replace(/\s+$/u, '')
    chunks.push(head.length > 0 ? head : window.join(''))
    rest = [...rest].slice(cut).join('').replace(/^\s+/u, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks.length > 0 ? chunks : ['']
}

/**
 * A legjobb vágási pozíció (kódpont-index) a `[0, limit]` ablakban: előbb bekezdéshatár
 * (`\n\n`), aztán sorhatár (`\n`), aztán szóhatár (szóköz); ha egyik sincs az ablak
 * második felében, kényszervágás a `limit`-en (egy hosszú, tagolatlan blokk).
 */
function bestCutIndex(windowStr: string, limit: number): number {
  const half = Math.floor(limit / 2)
  const candidates = [windowStr.lastIndexOf('\n\n'), windowStr.lastIndexOf('\n'), windowStr.lastIndexOf(' ')]
  for (const idx of candidates) {
    if (idx >= half) return idx + 1
  }
  return limit
}

/**
 * Egy több-darabos válasz darab-jelölője (pl. „(2/3)"). Egyetlen darabnál üres string.
 */
export function chunkCounterLabel(index: number, total: number): string {
  return total > 1 ? `(${index + 1}/${total})` : ''
}
