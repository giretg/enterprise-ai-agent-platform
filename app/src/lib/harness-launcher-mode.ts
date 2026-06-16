export type HarnessLauncherMode = 'local-wiki' | 'docker-local' | 'cloud-run-job'

export function getHarnessLauncherMode(): HarnessLauncherMode {
  const mode = process.env.HARNESS_LAUNCHER_MODE ?? 'local-wiki'
  if (mode === 'docker-local' || mode === 'cloud-run-job' || mode === 'local-wiki') {
    return mode
  }
  throw new Error(`Unsupported HARNESS_LAUNCHER_MODE: ${mode}`)
}

/** Goose harness külön folyamatban fut — a válasz callback után érkezik. */
export function isAsyncHarnessLauncher(mode = getHarnessLauncherMode()): boolean {
  return mode === 'docker-local' || mode === 'cloud-run-job'
}
