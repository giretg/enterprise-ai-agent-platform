/**
 * Control Plane panel store: modal bezárás URL-ről hidratált panelnél is.
 * Folyamatok oldal: bal oldali témaválasztó (SettingsSectionShell).
 *
 * Futtatás: npx tsx scripts/control-plane-panel-store.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

const root = resolve(import.meta.dirname, '..')
const storeSrc = readFileSync(resolve(root, 'src/lib/control-plane-panel-store.ts'), 'utf8')
const routeModalSrc = readFileSync(resolve(root, 'src/components/ui/route-modal.tsx'), 'utf8')
const processesSrc = readFileSync(resolve(root, 'src/app/control-plane/processes/page.tsx'), 'utf8')

console.log('\nControl Plane panel store — close\n')

check('closeControlPlanePanelByKey az effective (URL) kulcsot is törli', () => {
  assert.match(
    storeSrc,
    /closeControlPlanePanelByKey[\s\S]*?effectivePanelKey\(\)/,
    'ByKey-nek az URL-ből olvasott aktív panelt is zárnia kell, nem csak a module panelKey-t',
  )
})

check('RouteModalHost mountkor szinkronizálja a panel kulcsot az URL-ből', () => {
  assert.match(
    routeModalSrc,
    /setMounted\(true\)[\s\S]{0,400}?syncControlPlanePanelFromUrl\(\)/,
    'mountkor URL→store szinkron kell, különben a frissített ?panel= X-e nem zár',
  )
})

check('closeControlPlanePanelByKey URL-t is töröl ha az aktív panel a zárandó', () => {
  assert.match(
    storeSrc,
    /closeControlPlanePanelByKey[\s\S]*?syncUrlPanelParam\(null/,
    'URL panel param törlése kötelező a bezáráskor',
  )
})

console.log('\nFolyamatok — témaválasztó\n')

check('Folyamatok oldal SettingsSectionShell-t használ (bal oldali témaválasztó)', () => {
  assert.match(processesSrc, /SettingsSectionShell/, 'SettingsSectionShell import/használat')
  assert.match(processesSrc, /id: 'uj-folyamat'/, 'Új Folyamat szekció')
  assert.match(processesSrc, /id: 'uj-futas'/, 'Új Futás szekció')
  assert.match(processesSrc, /id: 'folyamatok'/, 'Folyamatok szekció')
  assert.match(processesSrc, /id: 'futasok'/, 'Futások szekció')
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\ncontrol-plane-panel-store tests passed')
