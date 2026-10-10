/**
 * Egyfájlos céges Hermes-telepítő.
 * Futtatás: npm run test:hermes-installer
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import bundled from '../src/domain/client-policy/hermes-installer-files.json'
import {
  INSTALLER_ASSET_PATHS,
  MANAGED_INSTALLER_FILENAME,
  buildManagedInstallerScript,
  bundledInstallerFiles,
} from '../src/domain/client-policy/hermes-installer'
import { buildManagedFiles } from '../src/domain/client-policy/machine-floor'
import { readInstallerAssets } from './sync-hermes-installer-assets'

let failures = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

const source = readInstallerAssets()

check('a becsomagolt telepítőfájlok a clients/hermes-guard másolatai', () => {
  for (const rel of INSTALLER_ASSET_PATHS) {
    assert.equal((bundled as Record<string, string>)[rel], source[rel], rel)
  }
  assert.equal(Object.keys(bundledInstallerFiles()).length, INSTALLER_ASSET_PATHS.length)
})

check('az egyfájlos telepítő --prefix mellett felteszi a padlót és a Guardot', () => {
  const built = buildManagedFiles({
    gatewayBaseUrl: 'https://excellence.example/api/model-gateway/v1',
    disabledToolsets: ['terminal'],
    installId: 'inst-test',
  })
  const script = buildManagedInstallerScript({
    installId: 'inst-test',
    gatewayBaseUrl: 'https://excellence.example/api/model-gateway/v1',
    agentIds: [],
    disabledToolsets: ['terminal'],
    ...built,
  })
  assert.match(script, /^#!/)
  assert.match(script, new RegExp(MANAGED_INSTALLER_FILENAME.replace('.', '\\.')))
  const dir = mkdtempSync(join(tmpdir(), 'exc-installer-'))
  try {
    const file = join(dir, MANAGED_INSTALLER_FILENAME)
    writeFileSync(file, script, { encoding: 'utf8', mode: 0o755 })
    const prefix = join(dir, 'stage')
    const result = spawnSync('bash', [file, '--prefix', prefix], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(join(prefix, 'etc/hermes/config.yaml'), 'utf8'), /provider: "excellence"/)
    assert.equal(readFileSync(join(prefix, 'etc/hermes/excellence-install-id'), 'utf8'), 'inst-test\n')
    assert.ok(readFileSync(join(prefix, 'opt/excellence/bin/exc-token'), 'utf8').length > 0)
    assert.ok(readFileSync(join(prefix, 'opt/excellence/hermes-plugins/excellence-guard/plugin.yaml'), 'utf8').length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
