import { createHash } from 'crypto'

/**
 * Agent service-account API-kulcs alaki előtagja. Minden platform-kulcs ezzel kezdődik
 * (`cp_sk_` + magas entrópiájú titok), így a hitelesítés gyorsan elutasíthatja a nem
 * platform-formátumú tokeneket, mielőtt bármilyen adatbázis- vagy hash-műveletet végezne.
 */
export const AGENT_API_KEY_PREFIX = 'cp_sk_'

export function isAgentApiKeyFormat(rawKey: string): boolean {
  return rawKey.startsWith(AGENT_API_KEY_PREFIX)
}

/**
 * Determinisztikus, indexelhető kereső-hash a nyers API-kulcsból.
 *
 * A kulcs *nyugalmi* titka továbbra is bcrypt-tel van tárolva (lassú, sózott — véd az
 * adatbázis-szivárgás elleni brute-force-tól). Ez a SHA-256 hash KIZÁRÓLAG gyors,
 * egyedi-indexelt megkeresésre szolgál: a hitelesítés O(1) `findUnique`-kal megtalálja
 * a pontos kulcssort, ahelyett hogy minden aktív kulcson végig-bcrypt-elne (O(n)).
 *
 * Miért biztonságos önmagában a SHA-256 keresésre: a kulcs 128 bit egyenletes véletlen
 * (`randomBytes(16)`), amit egy determinisztikus hash nem gyengít kimerítő kereséssel
 * visszafejthető szintre. A bcrypt-ellenőrzés így is megmarad mélységi védelemként.
 */
export function deriveAgentApiKeyLookupHash(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}
