import { getHarnessLauncherMode, type HarnessLauncherMode } from '@/lib/harness-launcher-mode'

/** Amit a felületet kiszolgáló szerverfolyamat tud a saját futtató-környezetéről. */
export type DispatcherRuntimeView = {
  /** null, ha a HARNESS_LAUNCHER_MODE env értéke érvénytelen. */
  mode: HarnessLauncherMode | null
  rawMode: string
  /** Hamis, ha nincs env beállítva és a beépített alapértelmezés érvényesül. */
  modeFromEnv: boolean
  /** A `cloud-run-job` módhoz hiányzó env-változók ezen a szerveren. */
  missingCloudRunEnv: string[]
}

/** A `cloud-run-job` launcher ezek nélkül azonnal dobna (`cloudRunConfigFromEnv`). */
const CLOUD_RUN_JOB_REQUIRED_ENV = [
  'HARNESS_CLOUD_RUN_PROJECT_ID',
  'HARNESS_CLOUD_RUN_LOCATION',
  'HARNESS_CLOUD_RUN_JOB_NAME',
] as const

/**
 * Ezek nélkül a launcher elindul, de a Job nem tud visszaszólni az eredménnyel
 * (`harness-run-env.ts`: callbackUrl = HARNESS_CALLBACK_URL || PLATFORM_API_URL) — vagyis a
 * hiba néma lenne. Elég az egyik.
 */
const CLOUD_RUN_JOB_CALLBACK_ENV = ['HARNESS_CALLBACK_URL', 'PLATFORM_API_URL'] as const

/**
 * Amit ez a konkrét szerverfolyamat tud magáról: melyik futtató-környezetben indítana agentet,
 * és hogy a Cloud Run Job célpont egyáltalán be van-e kötve az env-jébe. E nélkül az admin csak
 * találgatna, hogy az „engedélyezett módok” kapcsolói közül melyik hat erre a szerverre.
 *
 * Csak szerveroldalon hívható (`process.env`).
 */
export function readDispatcherRuntime(): DispatcherRuntimeView {
  let mode: HarnessLauncherMode | null = null
  try {
    mode = getHarnessLauncherMode()
  } catch {
    // Érvénytelen env-érték: a panel ezt külön, hibaként jelzi.
    mode = null
  }
  const missing: string[] = CLOUD_RUN_JOB_REQUIRED_ENV.filter((name) => !process.env[name])
  if (CLOUD_RUN_JOB_CALLBACK_ENV.every((name) => !process.env[name])) {
    missing.push(CLOUD_RUN_JOB_CALLBACK_ENV.join(' vagy '))
  }
  return {
    mode,
    rawMode: process.env.HARNESS_LAUNCHER_MODE ?? 'local-wiki',
    modeFromEnv: Boolean(process.env.HARNESS_LAUNCHER_MODE),
    missingCloudRunEnv: missing,
  }
}
