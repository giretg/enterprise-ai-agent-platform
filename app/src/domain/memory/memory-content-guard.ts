/**
 * agent-memory-persistent-cross-conversation-spec.md §3.2 / §16 S3 (Q6 lezárva,
 * rétegzett) — a MECHANIKUS capture-idő tartalom-őr:
 *   - **hard-block** nagy-biztonságú kategóriára (detektált secret/kulcs) → a
 *     javaslat NEM jön létre;
 *   - **figyelmeztetés** (nem blokkol, a jóváhagyó dönt) a lágy PII-re — egy
 *     tisztán blokkoló kapu false-positive-jai megölnék a capture-UX-et.
 *
 * A szemantikai "ez transzkript / trivia-e" döntés továbbra is a §2.3 capture-
 * policy rendszerprompté (memory-acceptance-policy.ts fejléce); ez a modul csak
 * a gépileg megbízhatóan felismerhető, magas-biztonságú titok-mintákat fedi.
 */

type Pattern = { label: string; re: RegExp }

// Magas-biztonságú titok-minták — találat ⇒ HARD-BLOCK. Minden regex `test`-elt
// (nincs `/g` flag → nincs `lastIndex`-állapot, a modul-szintű újrahasználat safe).
const SECRET_PATTERNS: readonly Pattern[] = [
  { label: 'private_key_block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i },
  { label: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws_secret_access_key', re: /\baws_secret_access_key\b\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}\b/i },
  { label: 'gcp_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'gcp_oauth_token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { label: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: 'github_token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { label: 'stripe_secret_key', re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { label: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
]

// Lágy PII — találat ⇒ WARN (nem blokkol).
const SOFT_PII_PATTERNS: readonly Pattern[] = [
  { label: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: 'possible_card_number', re: /\b(?:\d[ -]?){13,16}\b/ },
  { label: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },
]

export type MemoryContentScanResult = {
  /** magas-biztonságú találatok → hard-block */
  secrets: string[]
  /** lágy PII találatok → figyelmeztetés */
  softPii: string[]
}

/** A candidate szabad-szöveges mezőit összefűzve vizsgálja (kategória-címkéket ad vissza, NEM a nyers találatot). */
export function scanMemoryContentForSecrets(
  fields: ReadonlyArray<string | null | undefined>,
): MemoryContentScanResult {
  const text = fields.filter((f): f is string => Boolean(f)).join('\n')
  if (!text) return { secrets: [], softPii: [] }
  return {
    secrets: SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label),
    softPii: SOFT_PII_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label),
  }
}
