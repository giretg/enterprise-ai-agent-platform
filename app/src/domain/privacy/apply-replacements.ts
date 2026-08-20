/**
 * Span-csere közös implementációja (APG-16/17/21).
 *
 * Minden privacy-réteg ugyanazt a szabályt követi: a spanok jobbról balra
 * cserélődnek (így a korábbi indexek érvényben maradnak), és az átfedő spanok
 * közül csak az első — a leghosszabb, a hívó rendezése szerint — érvényesül.
 * Ha ez a szabály rétegenként szétcsúszik, elmozdulnak az offsetek, és egy
 * maszkolatlan cégnév vagy e-mail cím megy ki a modellnek.
 */

export type SurrogateReplacement = {
  start: number
  end: number
  surrogate: string
}

export function applySurrogateReplacements(
  text: string,
  replacements: readonly SurrogateReplacement[],
): string {
  if (replacements.length === 0) return text
  const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  let cut = out.length
  for (const slot of sorted) {
    if (slot.end > cut) continue
    out = out.slice(0, slot.start) + slot.surrogate + out.slice(slot.end)
    cut = slot.start
  }
  return out
}
