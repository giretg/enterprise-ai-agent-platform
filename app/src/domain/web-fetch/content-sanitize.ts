/**
 * Determinisztikus tartalom-sanitizálás a drafting ELŐTT (Feature-spec — WebFetch-Egress
 * §7.2/10). Cél: a token-költség ÉS a prompt-injection-felület csökkentése — a
 * megbízhatatlan HTML-ből a végrehajtható/rejtett részeket eltávolítjuk, csak a látható
 * szöveget (és a `<code>`/`<pre>` tartalmát) tartjuk meg, majd hossz-limitre vágjuk.
 *
 * FONTOS: ez NEM biztonsági határ önmagában — a tartalom a fogyasztónál mindig ADAT,
 * sosem utasítás (§3.2). A sanitizálás a defense-in-depth egyik rétege.
 */

const HTML_CONTENT_TYPES = /^text\/html\b/i

/** `<script>`, `<style>`, HTML-komment, `<iframe>`, `<object>` blokkok teljes törlése. */
function stripDangerousBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, ' ')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, ' ')
    // Önzáró / nyitó iframe/object/embed maradékok.
    .replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, ' ')
}

/** A maradék taggeket eltávolítja; a szöveg (köztük a `<code>`/`<pre>` tartalma) megmarad. */
function stripTags(html: string): string {
  return html.replace(/<\/?[a-z][^>]*>/gi, ' ')
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * A tartalom sanitizálása a content-type szerint. HTML-t megtisztít; a strukturált
 * alakokat (JSON/XML/YAML/markdown/plain) változatlanul hagyja (már „adat"), csak
 * a közös hossz-limitet alkalmazza.
 */
export function sanitizeFetchedContent(input: {
  raw: string
  contentType: string
  maxContentChars: number
}): string {
  let text = input.raw
  if (HTML_CONTENT_TYPES.test(input.contentType)) {
    text = decodeBasicEntities(stripTags(stripDangerousBlocks(text)))
  }
  text = collapseWhitespace(text)
  if (text.length > input.maxContentChars) {
    text = text.slice(0, input.maxContentChars)
  }
  return text
}
