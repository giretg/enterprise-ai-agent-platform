/**
 * Markdown-renderelő URL-policy (APG-07 előfeltétel, spec §10.3).
 *
 * A chat markdownja nem megbízható: a modell (vagy a felhasználó) tetszőleges
 * linket és képet tehet bele. Külső kép auto-betöltése beacon / exfiltráció;
 * `javascript:` link aktív kód. KEEP surfaces that render markdown must use this
 * policy; the former ChatMarkdown renderer lives under `legacy/`.
 */

export const unresolvedSurrogateHint =
  'Feloldatlan álnév: a nyers érték itt nem jelenhet meg (link, kép vagy kód).'

export function isSafeMarkdownImageSrc(src: string | undefined | null): boolean {
  if (!src) return false
  const value = src.trim()
  if (value.startsWith('data:image/')) return true
  // Same-origin relatív út (workspace-fájl). Protokoll-relatív `//host` tilos.
  if (value.startsWith('/') && !value.startsWith('//')) return true
  return false
}

export function isSafeMarkdownLinkHref(href: string | undefined | null): boolean {
  if (!href) return false
  const value = href.trim()
  if (/^(javascript|vbscript|data):/i.test(value)) return false
  return true
}
