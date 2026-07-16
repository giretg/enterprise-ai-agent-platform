import { timingSafeEqual } from 'crypto'

/**
 * Konstans idejű megosztott-titok összehasonlítás a privilegizált belső végpontokhoz
 * (dispatcher control token, harness completion callback, metrics scrape).
 *
 * Miért kell: ezek a végpontok NEM a Clerk-felhasználói auth mögött ülnek, hanem egyetlen
 * megosztott bearer/fejléc-titokkal védettek. A naiv `provided !== expected` byte-onként,
 * korai kilépéssel hasonlít — a lefutási idő így az első eltérő byte pozíciójától függ, ami
 * elvben egy timing-oracle: a támadó a válaszidőből byte-onként kikövetkeztetheti a titkot.
 * Hálózaton át ez nehéz, de egy platform-vezérlő titoknál olcsó és elvárt keményítés — és a
 * kódbázis már ezt a mintát követi az OAuth-state és a sandbox preview-token ellenőrzésénél.
 *
 * Fail-closed: ha bármelyik oldal hiányzik/üres, `false`. A hossz-eltérés is `false`, de a
 * `timingSafeEqual` egyenlő hosszú bufferekre fut, hogy ne dobjon — a hossz-összehasonlítás
 * önmagában csak a titok HOSSZÁT szivárogtatja, nem a tartalmát, ami elfogadott kompromisszum
 * (ugyanaz, mint az `oauth-state.ts` / `preview-token.ts` mintában).
 */
export function safeSecretEquals(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false
  const providedBuf = Buffer.from(provided, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}
