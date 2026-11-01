/**
 * Egyfájlos céges Hermes-telepítő.
 * Futtatás: npm run test:hermes-installer
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import bundled from '../src/domain/client-policy/hermes-installer-files.json'
import {
  INSTALLER_ASSET_PATHS,
  MANAGED_INSTALLER_FILENAME,
  MANAGED_WINDOWS_INSTALLER_FILENAME,
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

function samplePackage(platform: 'posix' | 'windows') {
  const built = buildManagedFiles({
    gatewayBaseUrl: 'https://excellence.example/api/model-gateway/v1',
    disabledToolsets: ['terminal'],
    installId: 'inst-test',
    platform,
  })
  return {
    installId: 'inst-test',
    platform,
    gatewayBaseUrl: 'https://excellence.example/api/model-gateway/v1',
    agentIds: [],
    disabledToolsets: ['terminal'],
    bots: [
      {
        profile: 'exc-kati',
        agentId: '11111111-1111-4111-8111-111111111111',
        files: {
          'SOUL.md': '# Kati\n\nconnector to Kati\n',
          'profile.yaml': 'display_name: Kati\n',
          'config.yaml': 'mcp_servers:\n  excellence:\n    url: https://excellence.example/api/mcp/acme\n',
          'distribution.yaml': 'name: exc-kati\n',
        },
      },
    ],
    ...built,
  }
}

function sampleScript() {
  return buildManagedInstallerScript(samplePackage('posix'))
}

function sampleWindowsScript() {
  return buildManagedInstallerScript(samplePackage('windows'))
}

const systemBash = existsSync('/bin/bash') ? '/bin/bash' : 'bash'

check('az egyfájlos telepítő --prefix mellett felteszi a padlót és a Guardot', () => {
  const script = sampleScript()
  assert.match(script, /^#!/)
  assert.match(script, new RegExp(MANAGED_INSTALLER_FILENAME.replace('.', '\\.')))
  assert.doesNotMatch(script, /PREFIX_ARGS/)
  const dir = mkdtempSync(join(tmpdir(), 'exc-installer-'))
  try {
    const file = join(dir, MANAGED_INSTALLER_FILENAME)
    writeFileSync(file, script, { encoding: 'utf8', mode: 0o755 })
    const prefix = join(dir, 'stage')
    mkdirSync(join(prefix, 'home/.hermes/mcp-tokens'), { recursive: true })
    writeFileSync(join(prefix, 'home/.hermes/mcp-tokens/excellence.json'), '{"access_token":"oauth-parent"}\n')
    const result = spawnSync(systemBash, [file, '--prefix', prefix], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(join(prefix, 'etc/hermes/config.yaml'), 'utf8'), /provider: "excellence"/)
    assert.equal(readFileSync(join(prefix, 'etc/hermes/excellence-install-id'), 'utf8'), 'inst-test\n')
    assert.ok(readFileSync(join(prefix, 'opt/excellence/bin/exc-token'), 'utf8').length > 0)
    assert.ok(readFileSync(join(prefix, 'opt/excellence/hermes-plugins/excellence-guard/plugin.yaml'), 'utf8').length > 0)
    assert.match(readFileSync(join(prefix, 'home/.hermes/profiles/exc-kati/SOUL.md'), 'utf8'), /connector to Kati/)
    assert.ok(existsSync(join(prefix, 'home/.hermes/profiles/exc-kati/plugins/excellence-guard/plugin.yaml')))
    assert.equal(
      readFileSync(join(prefix, 'home/.hermes/profiles/exc-kati/mcp-tokens/excellence.json'), 'utf8'),
      '{"access_token":"oauth-parent"}\n',
    )
    // #1043: a Bot MCP-hívásai a gép telepítés-azonosítójával mennek.
    assert.match(
      readFileSync(join(prefix, 'home/.hermes/profiles/exc-kati/config.yaml'), 'utf8'),
      /\n    headers:\n      X-Excellence-Install-Id: 'inst-test'\n$/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('sudo bash útvonal argumentum nélkül eljut a padlóig', () => {
  const script = sampleScript()
  const dir = mkdtempSync(join(tmpdir(), 'exc-installer-root-'))
  try {
    const file = join(dir, MANAGED_INSTALLER_FILENAME)
    writeFileSync(file, script, { encoding: 'utf8', mode: 0o755 })
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n', { encoding: 'utf8', mode: 0o755 })
    writeFileSync(join(bin, 'bash'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { encoding: 'utf8', mode: 0o755 })
    const result = spawnSync(systemBash, [file], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    })
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, output)
    assert.doesNotMatch(output, /unbound variable/)
    assert.match(result.stdout, /install-managed\.sh/)
    assert.match(result.stdout, /floor\.json/)
    assert.doesNotMatch(result.stdout, /--prefix/)
    assert.match(result.stdout, /Kész/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a Windows-telepítő önkicsomagoló PowerShell, és a padló windows platformú', () => {
  const script = sampleWindowsScript()
  assert.match(script, /^# Excellence/)
  assert.match(script, /^param\(/m)
  assert.match(script, new RegExp(MANAGED_WINDOWS_INSTALLER_FILENAME.replace('.', '\\.')))
  assert.match(script, /install-managed\.ps1/)
  assert.doesNotMatch(script, /^#!/)
  assert.match(JSON.stringify(samplePackage('windows')), /"platform":"windows"/)
})

check('a Windows-telepítő --Prefix mellett felteszi a padlót, ha van pwsh', () => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' })
  if (pwsh.status !== 0) {
    console.log('  skip  Windows-telepítő élő futtatás (nincs pwsh)')
    return
  }
  const script = sampleWindowsScript()
  const dir = mkdtempSync(join(tmpdir(), 'exc-win-installer-'))
  try {
    const file = join(dir, MANAGED_WINDOWS_INSTALLER_FILENAME)
    writeFileSync(file, script, { encoding: 'utf8' })
    const prefix = join(dir, 'stage')
    mkdirSync(join(prefix, 'home/AppData/Local/hermes/mcp-tokens'), { recursive: true })
    writeFileSync(join(prefix, 'home/AppData/Local/hermes/mcp-tokens/excellence.json'), '{"access_token":"oauth-parent"}\n')
    const result = spawnSync('pwsh', ['-NoProfile', '-File', file, '-Prefix', prefix], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(join(prefix, 'ProgramData/Excellence/hermes/config.yaml'), 'utf8'), /exc-token\.cmd/)
    assert.equal(readFileSync(join(prefix, 'ProgramData/Excellence/hermes/excellence-install-id'), 'utf8'), 'inst-test\n')
    assert.ok(existsSync(join(prefix, 'ProgramData/Excellence/hermes-plugins/excellence-guard/plugin.yaml')))
    assert.match(readFileSync(join(prefix, 'home/AppData/Local/hermes/profiles/exc-kati/SOUL.md'), 'utf8'), /connector to Kati/)
    assert.equal(
      readFileSync(join(prefix, 'home/AppData/Local/hermes/profiles/exc-kati/mcp-tokens/excellence.json'), 'utf8'),
      '{"access_token":"oauth-parent"}\n',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('az install-managed.sh floor.json nélkül nem telepít, még ha a fájl mellette van is', () => {
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../clients/hermes-guard/install-managed.sh')
  const dir = mkdtempSync(join(tmpdir(), 'exc-floor-required-'))
  try {
    const script = join(dir, 'install-managed.sh')
    copyFileSync(source, script)
    writeFileSync(join(dir, 'floor.json'), '{}\n')
    const result = spawnSync(systemBash, [script], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /floor\.json/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Hibás installId|Gép-padló/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
