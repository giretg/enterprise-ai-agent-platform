export type HarnessMode = 'wiki' | 'callback-only'

export function parseHarnessMode(value: string | undefined): HarnessMode {
  const mode = value?.trim() || 'wiki'
  if (mode === 'wiki' || mode === 'callback-only') return mode
  throw new Error(`Unsupported HARNESS_MODE: ${mode}`)
}
