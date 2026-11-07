import {
  decideFeatureFlag,
  FEATURE_FLAG_STATE_OFF,
  type FeatureFlagState,
} from './evaluate'

export type FeatureFlagScope = { tenantId: string }

export type FeatureFlagReader<K extends string = string> = {
  isEnabled(key: K, scope: FeatureFlagScope): Promise<boolean>
}

export type FeatureFlagSnapshot = ReadonlyMap<string, FeatureFlagState>

const DEFAULT_TTL_MS = 30_000
const DEFAULT_LOAD_TIMEOUT_MS = 5_000
const DEFAULT_RETRY_MS = 5_000

export type FeatureFlagEvaluator<K extends string = string> = FeatureFlagReader<K> & {
  /** A módosító példány hívja, hogy a saját következő döntése már az új állapotból menjen. */
  invalidate(): void
}

/**
 * A teljes állapotot egy lekérdezés tölti be, így egy oldalmegnyitás nem kérdez flagenként.
 *
 * - A lejárat a betöltés indulásától számít, a leállítás ezért kb. 30 mp alatt ér el minden példányt.
 * - Az egyidejű betöltések összevonódnak.
 * - Hiba vagy túl lassú válasz esetén az utolsó ismert állapot marad; ha nincs ilyen, minden flag Ki.
 * - Hiba után rövid ideig nem próbálkozik újra, hogy a kiesést ne terhelje kérésenként egy lekérdezés.
 */
export function createFeatureFlagEvaluator<K extends string = string>(deps: {
  load: () => Promise<FeatureFlagSnapshot>
  now?: () => number
  ttlMs?: number
  loadTimeoutMs?: number
  retryMs?: number
  onLoadError?: (error: unknown) => void
}): FeatureFlagEvaluator<K> {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS

  let snapshot: FeatureFlagSnapshot | null = null
  let nextLoadAt = 0
  let inFlight: Promise<void> | null = null
  // Az `invalidate` előtt indult betöltés már a régi állapotot hozhatja, ezért eldobjuk.
  let generation = 0

  const startLoad = (): Promise<void> => {
    const startedAt = now()
    const startedGeneration = generation
    const load = deps
      .load()
      .then((loaded) => {
        if (startedGeneration !== generation) return
        snapshot = loaded
        nextLoadAt = startedAt + ttlMs
      })
      .catch((error: unknown) => {
        deps.onLoadError?.(error)
        if (startedGeneration === generation) nextLoadAt = now() + retryMs
      })
      .finally(() => {
        if (inFlight === load) inFlight = null
      })
    inFlight = load
    return load
  }

  const waitForLoad = async (load: Promise<void>): Promise<void> => {
    const startedGeneration = generation
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), loadTimeoutMs)
    })
    const slow = await Promise.race([load.then(() => false), timedOut])
    clearTimeout(timer)
    // A lassú adatbázis ne késleltessen minden kérést: egy ideig az ismert állapotból döntünk.
    if (slow && startedGeneration === generation) nextLoadAt = now() + retryMs
  }

  const currentSnapshot = async (): Promise<FeatureFlagSnapshot | null> => {
    if (now() < nextLoadAt) return snapshot
    await waitForLoad(inFlight ?? startLoad())
    return snapshot
  }

  return {
    async isEnabled(key, scope) {
      if (!scope.tenantId) return false
      const state = (await currentSnapshot())?.get(key) ?? FEATURE_FLAG_STATE_OFF
      return decideFeatureFlag(state, scope.tenantId).active
    },
    invalidate() {
      generation += 1
      nextLoadAt = 0
      inFlight = null
    },
  }
}

/** Teszt-kiértékelő: `true`/`false` minden cégre, vagy a felsorolt cégeknél aktív. */
export function createStaticFeatureFlags<K extends string = string>(
  values: Readonly<Partial<Record<K, boolean | readonly string[]>>> = {} as Readonly<Partial<Record<K, boolean>>>,
): FeatureFlagReader<K> {
  return {
    async isEnabled(key, scope) {
      if (!scope.tenantId) return false
      const value = values[key] as boolean | readonly string[] | undefined
      return Array.isArray(value) ? value.includes(scope.tenantId) : value === true
    },
  }
}
