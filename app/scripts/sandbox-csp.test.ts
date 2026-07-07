/**
 * Sandbox-app HTML kiszolgálás CSP — DB nélküli, tiszta logikai tesztek.
 * A kulcs-invariáns: az agent-írta HTML átlátszatlan origó-ba van zárva (`sandbox`
 * direktíva), és a network/form/object/base tiltott, függetlenül a deployment-configtól.
 * Futtatás: npm run test:sandbox-csp
 */
import assert from 'node:assert/strict'
import { sandboxPreviewCsp, sandboxExportCsp } from '../src/lib/sandbox-csp'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

function directives(csp: string): string[] {
  return csp.split(';').map((d) => d.trim())
}

check('preview: sandbox allow-scripts (átlátszatlan origó, de script fut)', () => {
  const dirs = directives(sandboxPreviewCsp("'self'"))
  assert.ok(dirs.includes('sandbox allow-scripts'), 'hiányzik a sandbox direktíva')
  // allow-same-origin SOHA nem lehet benne — az visszaadná a platform-origó hozzáférést
  assert.ok(!sandboxPreviewCsp("'self'").includes('allow-same-origin'), 'allow-same-origin nem engedett')
})

check('preview: network/form/object/base tiltott (nincs exfil-csatorna)', () => {
  const dirs = directives(sandboxPreviewCsp("'self'"))
  assert.ok(dirs.includes("default-src 'none'"))
  assert.ok(dirs.includes("connect-src 'none'"))
  assert.ok(dirs.includes("form-action 'none'"))
  assert.ok(dirs.includes("object-src 'none'"))
  assert.ok(dirs.includes("base-uri 'none'"))
})

check('preview: frame-ancestors a megadott origóra szűkít (clickjacking-védelem)', () => {
  const dirs = directives(sandboxPreviewCsp('https://app.example.com'))
  assert.ok(dirs.includes('frame-ancestors https://app.example.com'))
})

check('export: sandbox allow-scripts + beágyazás tiltva (frame-ancestors none)', () => {
  const dirs = directives(sandboxExportCsp())
  assert.ok(dirs.includes('sandbox allow-scripts'))
  assert.ok(dirs.includes("frame-ancestors 'none'"))
  assert.ok(dirs.includes("connect-src 'none'"))
})

check('export: allow-same-origin SOHA (letöltött fájl sem kap platform-origót)', () => {
  assert.ok(!sandboxExportCsp().includes('allow-same-origin'), 'allow-same-origin nem engedett exportban')
})

check('preview: inline script/style engedett (a data-app renderéhez kell)', () => {
  const dirs = directives(sandboxPreviewCsp("'self'"))
  assert.ok(dirs.includes("script-src 'unsafe-inline'"))
  assert.ok(dirs.includes("style-src 'unsafe-inline'"))
})

console.log(failed === 0 ? `\nMinden teszt zöld (${passed}).` : `\n${failed} teszt bukott (${passed} zöld).`)
if (failed > 0) process.exit(1)
