/**
 * Inline (izolált) workspace-HTML megnyitás biztonsági válasz-fejlécei.
 *
 * A workspace HTML-jét NEM megbízhatónak tekintjük: agent írhatta (akár egy
 * külső dokumentumból származó prompt-injektálás hatására), vagy a felhasználó
 * töltötte fel. Mégis ugyanarról az originről érkezik, mint a platform, ezért
 * amikor `disposition=inline`-ként (böngészőben megjelenítve) szolgáljuk ki,
 * opak, jogosultság nélküli sandboxba kell zárni.
 *
 * A fejléceket EGY helyen tartjuk, mert két route (beszélgetés és ticket
 * workspace-fájl) szolgálja ki ugyanezt — ha külön-külön másolnánk a policyt,
 * a két belépő idővel széttarthatna, és az egyik gyengébb védelmet adna.
 *
 * A policy:
 *  - `sandbox` (token nélkül): nincs script-futtatás, form-küldés, popup és
 *    nincs same-origin — a HTML nem éri el a platform sütijeit/API-ját.
 *  - `default-src 'none'`: alapból semmilyen erőforrás nem tölthető (fetch,
 *    font, media, frame, gyerek-dokumentum).
 *  - `img-src data:`: KIZÁRÓLAG beágyazott (self-contained) kép. Külső host
 *    felé SEM `<img>`, SEM CSS `url()` háttérkép nem indíthat kérést — ez zárja
 *    azt a kiszivárogtatási/beacon csatornát, amin egy injektált HTML akkor is
 *    adatot küldhetne ki (a kérés URL-jébe kódolva) vagy jelezhetné a megnyitást
 *    egy külső szervernek, amikor egy ember megnyitja az előnézetet. Script
 *    tiltása önmagában ezt NEM zárja — a képbetöltést az `img-src` szabályozza.
 *  - `style-src 'unsafe-inline'`: a riport belső (inline) stílusaihoz, hogy a
 *    megjelenítés használható maradjon.
 *
 * Ha egy jövőbeli riportnak képre van szüksége, azt beágyazott `data:` URI-ként
 * kell tartalmaznia (self-contained HTML) — külső képhivatkozás tudatosan tilos.
 */
export const INLINE_HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

export const INLINE_HTML_CONTENT_SECURITY_POLICY =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/**
 * Meta-CSP a blob/srcdoc előnézethez. A `sandbox` direktíva csak HTTP-fejlécben
 * érvényes (meta-ban a spec szerint figyelmen kívül marad) — azt az iframe
 * `sandbox` attribútuma kényszeríti ki. Külső http(s) itt sem nyílhat.
 */
export const INLINE_HTML_META_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'"

const INLINE_HTML_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${INLINE_HTML_META_CSP}">`

/** Blob/srcdoc előnézet: a HTTP-fejléc CSP-je elveszik, ezért a HTML-be tesszük. */
export function htmlWithInlinePreviewCsp(html: string): string {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (open) => `${open}${INLINE_HTML_CSP_META}`)
  }
  return `<!doctype html><head>${INLINE_HTML_CSP_META}</head>${html}`
}

/** Az inline HTML-válaszra teendő biztonsági fejlécek (l. a fájl fejlécét). */
export function inlineHtmlPreviewSecurityHeaders(): Record<string, string> {
  return {
    'content-security-policy': INLINE_HTML_CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
}
