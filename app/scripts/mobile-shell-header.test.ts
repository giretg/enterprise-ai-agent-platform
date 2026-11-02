/**
 * Mobil fejléc regressziók:
 * - a hamburger menü minden menüpontra kattintva (csoporton kívüli felső
 *   menüpontokra is) és oldalváltáskor bezárul;
 * - a cégváltó mobilon is látszik;
 * - cégváltás / kilépés után az oldal teljesen újratölt az Áttekintésre.
 *
 * Futtatás: npm run test:mobile-shell-header
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shell = readFileSync(join(root, 'src/components/ui/shell.tsx'), 'utf8')
const switcher = readFileSync(join(root, 'src/components/tenant/tenant-switcher.tsx'), 'utf8')

let passed = 0
let failed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  OK  ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`)
  }
}

check('a mobil menü felső menüpontjai is bezárják a menüt', () => {
  assert.match(shell, /renderTopLeaf\(item, \(\) => setMobileMenuOpen\(false\)\)/)
})

check('oldalváltáskor a mobil menü bezárul', () => {
  assert.match(shell, /if \(menuPathname !== pathname\) \{[\s\S]*?setMobileMenuOpen\(false\)/)
})

check('a cégváltó mobilon sincs elrejtve', () => {
  assert.doesNotMatch(switcher, /className="relative hidden sm:block"/)
  assert.doesNotMatch(switcher, /className="hidden items-center[^"]*sm:inline-flex"/)
})

check('cégváltás és kilépés után teljes újratöltés az Áttekintésre', () => {
  assert.match(switcher, /const AFTER_SWITCH_PATH = '\/control-plane'/)
  const assigns = switcher.match(/window\.location\.assign\(AFTER_SWITCH_PATH\)/g) ?? []
  assert.equal(assigns.length, 2, 'switchTenant és exitTenant után is újratöltés kell')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
