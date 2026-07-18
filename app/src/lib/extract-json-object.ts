/**
 * Az első teljes JSON objektum kinyerése szövegből — tűri a ```json fence-t és
 * a körítő prózát is. Determinisztikus, zárójel-egyensúlyozó (string-literálokat átugorva).
 *
 * Szándékosan node-/domain-független leaf: kliens komponensek is importálhatják
 * (process-step-payload, trigger-input), anélkül hogy a gateway/`fs` láncot behúznák.
 */

/**
 * A JSON-stringeken BELÜLI nyers vezérlőkaraktereket (U+0000–U+001F) a szabályos escape-
 * szekvenciájukra cseréli (\n, \r, \t, egyébként \uXXXX), a stringen KÍVÜLI whitespace-t
 * érintetlenül hagyva. Így egy olyan modell-kimenet is parse-olhatóvá válik, amely nyers
 * sortörést hagyott egy kulcsban vagy egy többsoros értékben (a tartalom nem vész el).
 */
function escapeRawControlCharsInJsonStrings(slice: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      const code = ch.charCodeAt(0)
      if (code <= 0x1f) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

export function extractJsonObject(text: string): unknown {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text

  const start = candidate.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          // A modellek gyakran nyers vezérlőkaraktert (sortörés/tab) hagynak a JSON-stringekben,
          // ami érvénytelen JSON-t ad (pl. `{"provider\nName": "..."}` vagy egy többsoros
          // érték). Best-effort: a stringeken BELÜLI nyers control-chareket escape-eljük, és
          // egyszer újrapróbáljuk — a többsoros értékek tartalma így megmarad.
          try {
            return JSON.parse(escapeRawControlCharsInJsonStrings(slice))
          } catch {
            return null
          }
        }
      }
    }
  }
  return null
}
