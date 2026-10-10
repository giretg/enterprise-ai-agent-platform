/**
 * A clients/hermes-guard telepítőfájlokat a Next appba másolja,
 * hogy a Control Plane egyfájlos telepítőt tudjon kiadni.
 *
 * Futtatás: npx tsx scripts/sync-hermes-installer-assets.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALLER_ASSET_PATHS } from '../src/domain/client-policy/hermes-installer'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(appDir, '..', 'clients', 'hermes-guard')
const dest = join(appDir, 'src/domain/client-policy/hermes-installer-files.json')

export function readInstallerAssets(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of INSTALLER_ASSET_PATHS) {
    out[rel] = readFileSync(join(sourceDir, rel), 'utf8')
  }
  return out
}

const invoked = process.argv[1]?.includes('sync-hermes-installer-assets')
if (invoked) {
  writeFileSync(dest, `${JSON.stringify(readInstallerAssets(), null, 2)}\n`)
  console.log(`wrote ${dest}`)
}
