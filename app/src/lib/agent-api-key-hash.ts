import { createHmac } from 'crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

/**
 * Agent service-account API-kulcs alaki előtagja. Minden platform-kulcs ezzel kezdődik
 * (`cp_sk_` + magas entrópiájú titok), így a hitelesítés gyorsan elutasíthatja a nem
 * platform-formátumú tokeneket, mielőtt bármilyen adatbázis- vagy hash-műveletet végezne.
 */
export const AGENT_API_KEY_PREFIX = 'cp_sk_'

const AGENT_API_KEY_LOOKUP_SECRET = resolveSecret(
  ['AGENT_API_KEY_LOOKUP_SECRET', 'WRITE_GATE_SECRET'],
  'dev-agent-api-key-lookup-secret-change-in-prod',
)

export function isAgentApiKeyFormat(rawKey: string): boolean {
  return rawKey.startsWith(AGENT_API_KEY_PREFIX)
}

/**
 * Determinisztikus, indexelhető kereső-HMAC a nyers API-kulcsból.
 *
 * A kulcs *nyugalmi* titka továbbra is bcrypt-tel van tárolva (lassú, sózott — véd az
 * adatbázis-szivárgás elleni brute-force-tól). Ez a SHA-256 hash KIZÁRÓLAG gyors,
 * egyedi-indexelt megkeresésre szolgál: a hitelesítés O(1) `findUnique`-kal megtalálja
 * a pontos kulcssort, ahelyett hogy minden aktív kulcson végig-bcrypt-elne (O(n)).
 *
 * A szerveroldali kulcs miatt az adatbázis-szivárgás nem ad offline ellenőrzőt a nyers
 * API-kulcshoz, miközben a bcrypt-ellenőrzés mélységi védelemként változatlanul megmarad.
 */
export function deriveAgentApiKeyLookupHash(rawKey: string): string {
  // codeql[js/insufficient-password-hash] — this is a keyed lookup HMAC, not at-rest password storage;
  // the bcrypt keyHash remains the credential verifier.
  return createHmac('sha256', AGENT_API_KEY_LOOKUP_SECRET).update(rawKey, 'utf8').digest('hex')
}
