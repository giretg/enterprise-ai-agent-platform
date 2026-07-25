/**
 * Rövid élettartamú, in-memory titok-cache a FORRÓ, hitelesítés-ELŐTTI utakhoz.
 *
 * Miért kell: a bejövő csatorna-webhook (Telegram) minden egyes kérésnél feloldja a bot
 * webhook-titkát, hogy KONSTANS IDŐVEL összevesse a fejléccel. Élesben a feloldás egy
 * Secret Manager HTTPS-körfordulót jelent — és ez a POST publikus, hitelesítés-ELŐTTI:
 * bárki (a Telegramot hamisító támadó is) kiválthatja. Cache nélkül egy hamis-kérés-özön
 * kérésenként egy Secret Manager-hívást ÉS egy DB-lekérdezést generál → költség-amplifikáció,
 * a projekt Secret Manager kvótájának kimerítése (429), és ezen keresztül ÖN-DoS a platform
 * ÖSSZES connector-titok-feloldására. (Ugyanaz az osztály, mint az agent-API-kulcs O(n)
 * bcrypt-DoS: drága művelet a pre-auth úton.)
 *
 * A cache ezt egy rövid TTL-lel (alap: 60 mp) egyetlen körfordulóra szűkíti időablakonként,
 * úgy, hogy a KONSTANS IDEJŰ összehasonlítás és a fail-closed viselkedés változatlan marad:
 *  - CSAK a sikeres feloldást cache-eljük; a hibát (throw) SOSEM — így egy átmeneti Secret
 *    Manager-hiba nem ragad be, és a hívó fail-closed marad (dobás → a webhook nem dolgoz fel).
 *  - Az egyidejű cache-miss kérések MEGOSZTJÁK ugyanazt a folyamatban lévő feloldást
 *    (thundering-herd elkerülése egy hideg cache melletti terhelés-csúcsban).
 *
 * A rövid TTL azt jelenti: egy titok-rotáció legfeljebb `ttlMs`-ig érvényesül késleltetve —
 * elfogadott kompromisszum egy ritkán változó webhook-titoknál.
 */

export type TtlSecretCache = (key: string) => Promise<string>

export function createTtlSecretCache(
  loader: (key: string) => Promise<string>,
  ttlMs: number,
  now: () => number = Date.now,
): TtlSecretCache {
  const cache = new Map<string, { value: string; expiresAt: number }>()
  const inflight = new Map<string, Promise<string>>()

  return async (key: string): Promise<string> => {
    const hit = cache.get(key)
    if (hit) {
      if (hit.expiresAt > now()) return hit.value
      // Lejárt bejegyzés — takarítjuk, hogy a `cache` mérete a titok-kulcsok számához kötött
      // maradjon (ne halmozódjon a többé nem kért kulcsokból).
      cache.delete(key)
    }

    const pending = inflight.get(key)
    if (pending) return pending

    const promise = loader(key)
      .then((value) => {
        // CSAK a siker cache-elhető — a hibát a `finally` takarítja, de nem tárolja.
        cache.set(key, { value, expiresAt: now() + ttlMs })
        return value
      })
      .finally(() => {
        inflight.delete(key)
      })

    inflight.set(key, promise)
    return promise
  }
}
