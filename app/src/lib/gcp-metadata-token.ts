/**
 * Cloud Run ambient service-account token/e-mail feloldás, LEJÁRAT-TUDATOS
 * in-memory cache-sel.
 *
 * Miért kell: a workspace-tár (GCS REST) minden egyes művelete — olvasás, írás,
 * listázás, méret-lekérdezés — külön feloldotta a hozzáférési tokent, azaz egy
 * HTTP-körfordulót indított a metadata szerverre. Egy repo-import (~660 fájl)
 * vagy egy `file_search` így 600–2600 FELESLEGES token-kérést generált, fájlonként
 * sorosan. Üzleti hatás: az agent kód-olvasása másodpercek helyett fél percekig
 * tartott (mért eset: 29,5 mp egy keresésre), a felhasználó pedig a chatben
 * várakozott — miközben a token egy órán át érvényes lett volna.
 *
 * A cache ezt egyetlen körfordulóra szűkíti a token élettartamán belül:
 *  - a lejáratot a metadata szerver `expires_in` mezőjéből vesszük, biztonsági
 *    ráhagyással (skew) — így SOHA nem adunk vissza épp lejáró tokent;
 *  - CSAK a sikeres feloldást cache-eljük; a hibát sosem — átmeneti metadata-hiba
 *    nem ragadhat be, a hívó fail-closed marad;
 *  - az egyidejű cache-miss hívások MEGOSZTJÁK ugyanazt a folyamatban lévő
 *    feloldást (thundering herd elkerülése hideg cache melletti terhelés-csúcsban,
 *    pl. amikor a párhuzamos file_search 24 szálon indul).
 *
 * A szolgáltatásfiók e-mailje a példány élettartama alatt nem változik, ezért azt
 * lejárat nélkül tartjuk.
 */

const METADATA_BASE =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default'

/** Ennyivel a tényleges lejárat ELŐTT már újat kérünk (óra-eltérés + kérés-idő fedezete). */
const EXPIRY_SKEW_SECONDS = 120
/** Felső korlát: hosszú `expires_in` esetén se tartsunk tokent ennél tovább. */
const MAX_CACHE_SECONDS = 45 * 60
/** Ha a metadata szerver nem küld `expires_in`-t, konzervatívan ennyit tartunk. */
const FALLBACK_CACHE_SECONDS = 5 * 60

export class GcpMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GcpMetadataError'
  }
}

type TokenEntry = { value: string; expiresAt: number }

type MetadataCacheState = {
  token: TokenEntry | null
  tokenInflight: Promise<string> | null
  email: string | null
  emailInflight: Promise<string> | null
}

// Next dev alatt a server action-ök és az API route-ok külön modulpéldányt
// kaphatnak — a cache-t globalThis-en osztjuk (ugyanaz a minta, mint a
// workspace stub-store-nál), különben példányonként újra fetchelnénk.
const globalCache = globalThis as typeof globalThis & {
  __gcpMetadataTokenCache__?: MetadataCacheState
}

function state(): MetadataCacheState {
  return (globalCache.__gcpMetadataTokenCache__ ??= {
    token: null,
    tokenInflight: null,
    email: null,
    emailInflight: null,
  })
}

async function fetchAccessToken(): Promise<TokenEntry> {
  const res = await fetch(`${METADATA_BASE}/token`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (!res.ok) throw new GcpMetadataError(`Metadata server returned ${res.status}`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new GcpMetadataError('Metadata server returned no access_token')
  }
  const lifetimeSeconds =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? data.expires_in
      : FALLBACK_CACHE_SECONDS
  const cacheSeconds = Math.min(
    Math.max(lifetimeSeconds - EXPIRY_SKEW_SECONDS, 0),
    MAX_CACHE_SECONDS,
  )
  return { value: data.access_token, expiresAt: Date.now() + cacheSeconds * 1000 }
}

/**
 * Ambient service-account hozzáférési token. Cache-elt: a token élettartamán
 * belül nem indít újabb metadata-hívást.
 */
export async function getGcpAccessToken(): Promise<string> {
  const cache = state()
  const hit = cache.token
  if (hit && hit.expiresAt > Date.now()) return hit.value
  // Lejárt bejegyzés — takarítjuk, hogy egy meghiúsult frissítés se hagyjon
  // vissza használhatatlan tokent a cache-ben.
  if (hit) cache.token = null

  const pending = cache.tokenInflight
  if (pending) return pending

  const promise = fetchAccessToken()
    .then((entry) => {
      // CSAK a siker cache-elhető — hibát sosem tárolunk (fail-closed marad).
      cache.token = entry
      return entry.value
    })
    .finally(() => {
      cache.tokenInflight = null
    })

  cache.tokenInflight = promise
  return promise
}

async function fetchServiceAccountEmail(): Promise<string> {
  const res = await fetch(`${METADATA_BASE}/email`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (!res.ok) throw new GcpMetadataError(`Metadata server returned ${res.status}`)
  return res.text()
}

/**
 * Ambient service-account e-mail. `GCS_SERVICE_ACCOUNT_EMAIL` felülírja; egyébként
 * a metadata szervertől kérjük egyszer, és a folyamat élettartamáig tartjuk.
 */
export async function getGcpServiceAccountEmail(): Promise<string> {
  const configured = process.env.GCS_SERVICE_ACCOUNT_EMAIL?.trim()
  if (configured) return configured

  const cache = state()
  if (cache.email) return cache.email

  const pending = cache.emailInflight
  if (pending) return pending

  const promise = fetchServiceAccountEmail()
    .then((email) => {
      cache.email = email
      return email
    })
    .finally(() => {
      cache.emailInflight = null
    })

  cache.emailInflight = promise
  return promise
}

/** Csak tesztekhez: a folyamat-szintű cache ürítése. */
export function resetGcpMetadataCacheForTests(): void {
  globalCache.__gcpMetadataTokenCache__ = {
    token: null,
    tokenInflight: null,
    email: null,
    emailInflight: null,
  }
}
