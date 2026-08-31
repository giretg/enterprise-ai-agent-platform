/**
 * Rövid élettartamú, in-memory kérés-összevonás a vezérlőpult ÉLŐ-ÁLLAPOT
 * pollútjaihoz (`/api/agents/rail-state` és `/api/v1/active-runs`).
 *
 * Miért kell: a bal oldali agent-sáv és a fejléc „Futások" panel másodpercenként
 * frissül, és mindkettő UGYANAZT a `loadActiveRuns` adathalmazt kéri le (4–5 DB-
 * lekérdezés), a `rail-state` ráadásul még egy teljes agent-listát is. Több nyitott
 * fül / eszköz esetén ez lineárisan sokszorozódik. A kliensoldali ütemezést a
 * PR #402 (`useAdaptivePoll`) már megszelídítette; ez a modul a SZERVER-oldali,
 * pollonkénti DB-költséget csökkenti azzal, hogy egy rövid (alap: 2 mp) időablakon
 * belül a több, közel egyszerre érkező poll EGYETLEN adatbázis-kört oszt meg.
 *
 * Minta: `@/lib/crypto/ttl-secret-cache` — ugyanaz a három garancia:
 *  - CSAK a sikeres betöltést cache-eljük; a hibát (throw) SOSEM, így egy átmeneti
 *    `PostgreSQL … Closed` hiba nem ragad be egy egész TTL-re, és a hívó a saját
 *    hibakezelésén megy tovább.
 *  - Az egyidejű cache-miss kérések MEGOSZTJÁK ugyanazt a folyamatban lévő
 *    betöltést (thundering-herd elkerülése hideg cache mellett).
 *  - A lejárt bejegyzést a következő olvasás takarítja, így a `Map` mérete a
 *    (tenant, user) párok számához kötött marad.
 *  - Invalidálás (pl. vész-leállítás) után a már futó loader NEM írhat vissza régi
 *    adatot: scope-generációs számláló eldobja a lejárt betöltést.
 *
 * A kulcs MINDIG tartalmazza a tenant- és user-azonosítót (a `rail-state` az agent-
 * láthatóságot user-grant szerint szűri, a `loadActiveRuns` pedig a bejelentkezett
 * user saját futásait adja) — így két bizalmi határon át sosem szivárog adat.
 *
 * A rövid TTL ára: egy ebben a fülben indított/leállított futás legfeljebb `ttlMs`-ig
 * a korábbi állapotot mutathatja a sávban/panelen, mielőtt a következő poll behozza.
 * A vész-leállítás (`.../cancel`) ezért expliciten invalidál (lásd `invalidatePollScope`).
 */

export type CoalescingCache<T> = {
  get: (key: string, loader: () => Promise<T>) => Promise<T>
  /** Egy adott kulcs eldobása (pl. mutáció után az érintett user pollja). */
  invalidate: (key: string) => void
  /** Minden olyan kulcs eldobása, amely a megadott előtaggal kezdődik. */
  invalidatePrefix: (prefix: string) => void
  /** Csak teszthez: teljes ürítés. */
  clear: () => void
}

/** Invalidálási scope: poll-kulcsoknál `tenant|user|`, egyébként maga a kulcs. */
function scopeForKey(key: string): string {
  const parts = key.split('|')
  if (parts.length >= 3) return `${parts[0]}|${parts[1]}|`
  return key
}

export function createCoalescingCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
): CoalescingCache<T> {
  const cache = new Map<string, { value: T; expiresAt: number; scopeGen: number }>()
  const inflight = new Map<string, Promise<T>>()
  /** Scope-generáció: invalidálás után a már futó loader nem írhat vissza régi adatot. */
  const scopeGeneration = new Map<string, number>()

  function scopeGen(scope: string): number {
    return scopeGeneration.get(scope) ?? 0
  }

  function bumpScope(scope: string): void {
    scopeGeneration.set(scope, scopeGen(scope) + 1)
  }

  /** Ne halmozódjanak a többé nem kért (tenant, user) kulcsok: ha a `Map` nagyra
   *  nő, egy körben kidobjuk a lejártakat. A TTL rövid, így ez ritkán fut. */
  const PRUNE_THRESHOLD = 512
  function pruneExpired(at: number) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key)
    }
  }

  return {
    async get(key, loader) {
      const at = now()
      if (cache.size > PRUNE_THRESHOLD) pruneExpired(at)

      const scope = scopeForKey(key)
      const hit = cache.get(key)
      if (hit) {
        if (hit.expiresAt > at && hit.scopeGen === scopeGen(scope)) return hit.value
        cache.delete(key)
      }

      const pending = inflight.get(key)
      if (pending) return pending

      const genAtStart = scopeGen(scope)
      const promise = loader()
        .then((value) => {
          if (scopeGen(scope) === genAtStart) {
            cache.set(key, { value, expiresAt: now() + ttlMs, scopeGen: genAtStart })
          }
          return value
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    },
    invalidate(key) {
      bumpScope(scopeForKey(key))
      cache.delete(key)
      inflight.delete(key)
    },
    invalidatePrefix(prefix) {
      bumpScope(prefix)
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key)
      }
      for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) inflight.delete(key)
      }
    },
    clear() {
      cache.clear()
      inflight.clear()
    },
  }
}

/**
 * Folyamat-szintű példány. A poll-összevonásnak nem kell instance-ok között
 * konzisztensnek lennie — a cél a fülönkénti/eszközönkénti burst összecsukása
 * egy instance-on belül; a `minInstances: 0` melletti kevés instance így is a
 * DB-lekérdezések többségét megspórolja.
 */
const globalForPollCache = globalThis as unknown as {
  __pollCoalesceCache?: CoalescingCache<unknown>
}

/** Alap TTL: a poll-ütemek (5–20 mp) alatti, de a burst-öket (rail-state + active-runs
 *  ugyanabban a kliens-ciklusban, több fül) összefogó ablak. */
export const POLL_COALESCE_TTL_MS = 2_000

function sharedCache(): CoalescingCache<unknown> {
  if (!globalForPollCache.__pollCoalesceCache) {
    globalForPollCache.__pollCoalesceCache = createCoalescingCache<unknown>(POLL_COALESCE_TTL_MS)
  }
  return globalForPollCache.__pollCoalesceCache
}

/** Kulcs-namespace-ek. A `|` sosem fordul elő tenant/user UUID-ben. */
const SCOPE_PREFIX = (tenantId: string, userId: string) => `${tenantId}|${userId}|`

/**
 * Egy poll-olvasás összevonása. `namespace` különíti el a `rail-state` agent-
 * listát az `active-runs` futáslistától; `variant` a további kulcsrész (pl. szerep).
 */
export function coalescePollRead<T>(
  args: { tenantId: string; userId: string; namespace: 'rail-agents' | 'active-runs'; variant?: string },
  loader: () => Promise<T>,
): Promise<T> {
  const key = `${SCOPE_PREFIX(args.tenantId, args.userId)}${args.namespace}|${args.variant ?? ''}`
  return sharedCache().get(key, loader as () => Promise<unknown>) as Promise<T>
}

/**
 * Egy (tenant, user) minden poll-cache bejegyzésének eldobása — mutáció (pl. futás
 * vész-leállítás) után hívandó, hogy a rákövetkező `refresh()` friss adatot lásson.
 */
export function invalidatePollScope(tenantId: string, userId: string): void {
  sharedCache().invalidatePrefix(SCOPE_PREFIX(tenantId, userId))
}
