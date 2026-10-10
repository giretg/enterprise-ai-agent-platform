/**
 * Egyfájlos céges Hermes-telepítő: a gép-padló JSON + Guard/token fájlok
 * egy `sudo bash excellence-telepito.sh` scriptben.
 */
import { Buffer } from 'node:buffer'
import bundledFiles from './hermes-installer-files.json'
import type { MachineFloorPackage } from './machine-floor'

export const MANAGED_INSTALLER_FILENAME = 'excellence-telepito.sh'

export const INSTALLER_ASSET_PATHS = [
  'install-managed.sh',
  'exc_token.py',
  'exc-guard',
  'excellence-guard/__init__.py',
  'excellence-guard/plugin.yaml',
  'excellence-guard/policy.py',
  'excellence-guard/runtime.py',
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

/** Önkicsomagoló bash: kicsomagolja a padlót és a Guardot, majd futtatja az install-managed.sh-t. */
export function buildManagedInstallerScript(pkg: MachineFloorPackage): string {
  const files = [
    ...Object.entries(bundledInstallerFiles()),
    ['floor.json', `${JSON.stringify(pkg)}\n`],
  ]
  const payload = JSON.stringify(files.map(([path, content]) => [path, Buffer.from(content, 'utf8').toString('base64')]))
  const executable = JSON.stringify([...EXECUTABLE_PATHS])
  return `\
#!/usr/bin/env bash
# Excellence céges Hermes telepítő. A munkatárs gépén: sudo bash ${MANAGED_INSTALLER_FILENAME}
set -euo pipefail
PREFIX_ARGS=()
if [ "\${1:-}" = "--prefix" ]; then
  PREFIX_ARGS=(--prefix "\${2:?--prefix könyvtár kell}")
  shift 2
elif [ "\$(id -u)" -ne 0 ]; then
  echo "A telepítőhöz rendszergazdai jelszó kell. Futtasd: sudo bash \$0" >&2
  exit 1
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
bash "\$ROOT/install-managed.sh" "\${PREFIX_ARGS[@]}" "\$ROOT/floor.json"
echo "Kész. Indítsd újra a Hermest."
`
}
