/**
 * Egyfájlos céges Hermes-telepítő: a gép-padló JSON + Guard/token fájlok
 * egy `sudo bash excellence-telepito.sh` vagy `excellence-telepito.ps1` scriptben.
 */
import { Buffer } from 'node:buffer'
import bundledFiles from './hermes-installer-files.json'
import {
  MANAGED_INSTALLER_FILENAME,
  MANAGED_WINDOWS_INSTALLER_FILENAME,
  managedInstallerFilename,
} from './installer-filename'
import type { MachineFloorPackage } from './machine-floor'

export { MANAGED_INSTALLER_FILENAME, MANAGED_WINDOWS_INSTALLER_FILENAME, managedInstallerFilename }

export const INSTALLER_ASSET_PATHS = [
  'install-managed.sh',
  'install-managed.ps1',
  'exc_token.py',
  'exc-guard',
  'excellence-guard/__init__.py',
  'excellence-guard/plugin.yaml',
  'excellence-guard/policy.py',
  'excellence-guard/runtime.py',
  'excellence-guard/excellence_paths.py',
] as const

const EXECUTABLE_PATHS = new Set(['install-managed.sh', 'exc-guard'])

export function bundledInstallerFiles(): Record<(typeof INSTALLER_ASSET_PATHS)[number], string> {
  const files = bundledFiles as Record<string, string>
  for (const path of INSTALLER_ASSET_PATHS) {
    if (typeof files[path] !== 'string' || files[path].length === 0) {
      throw new Error(`Hiányzó telepítőfájl: ${path}`)
    }
  }
  return files as Record<(typeof INSTALLER_ASSET_PATHS)[number], string>
}

function installerFiles(pkg: MachineFloorPackage): [string, string][] {
  return [
    ...Object.entries(bundledInstallerFiles()),
    ['floor.json', `${JSON.stringify(pkg)}\n`],
  ]
}

/** Önkicsomagoló bash: kicsomagolja a padlót és a Guardot, majd futtatja az install-managed.sh-t. */
function buildPosixInstallerScript(pkg: MachineFloorPackage): string {
  const payload = JSON.stringify(installerFiles(pkg).map(([path, content]) => [path, Buffer.from(content, 'utf8').toString('base64')]))
  const executable = JSON.stringify([...EXECUTABLE_PATHS])
  return `\
#!/usr/bin/env bash
# Excellence céges Hermes telepítő. A munkatárs gépén: sudo bash ${MANAGED_INSTALLER_FILENAME}
set -euo pipefail
if [ "\${1:-}" = "--prefix" ]; then
  PREFIX_DIR="\${2:?--prefix könyvtár kell}"
  shift 2
else
  PREFIX_DIR=""
  if [ "\$(id -u)" -ne 0 ]; then
    echo "A telepítőhöz rendszergazdai jelszó kell. Futtasd: sudo bash \$0" >&2
    exit 1
  fi
fi
ROOT=\$(mktemp -d)
trap 'rm -rf "\$ROOT"' EXIT
python3 - "\$ROOT" <<'PY'
import base64, json, os, sys
root = sys.argv[1]
files = json.loads("""${payload}""")
executable = set(json.loads("""${executable}"""))
for rel, blob in files:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(blob))
    if rel in executable:
        os.chmod(path, 0o755)
PY
if [ -n "\$PREFIX_DIR" ]; then
  bash "\$ROOT/install-managed.sh" --prefix "\$PREFIX_DIR" "\$ROOT/floor.json"
else
  bash "\$ROOT/install-managed.sh" "\$ROOT/floor.json"
fi
echo "Kész. Indítsd újra a Hermest."
`
}

/** Önkicsomagoló PowerShell: kicsomagolja a padlót és a Guardot, majd futtatja az install-managed.ps1-et. */
function buildWindowsInstallerScript(pkg: MachineFloorPackage): string {
  const payload = JSON.stringify(
    installerFiles(pkg).map(([p, content]) => ({ p, b: Buffer.from(content, 'utf8').toString('base64') })),
  )
  return `\
# Excellence company Hermes installer. On the employee computer, from Administrator PowerShell:
# powershell -ExecutionPolicy Bypass -File ${MANAGED_WINDOWS_INSTALLER_FILENAME}
param([string]$Prefix = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$root = Join-Path ([IO.Path]::GetTempPath()) ('exc-installer-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $payload = @'
${payload}
'@
  foreach ($item in @($payload | ConvertFrom-Json)) {
    $path = $root
    foreach ($part in ([string]$item.p -split '/')) { $path = Join-Path $path $part }
    $dir = Split-Path -Parent $path
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String([string]$item.b))
  }
  $installer = Join-Path $root 'install-managed.ps1'
  $floor = Join-Path $root 'floor.json'
  if ($Prefix) {
    & $installer $floor -Prefix $Prefix
  } else {
    & $installer $floor
  }
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`
}

export function buildManagedInstallerScript(pkg: MachineFloorPackage): string {
  return pkg.platform === 'windows' ? buildWindowsInstallerScript(pkg) : buildPosixInstallerScript(pkg)
}

export function managedInstallerContentType(platform: MachineFloorPackage['platform']): string {
  return platform === 'windows' ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8'
}
