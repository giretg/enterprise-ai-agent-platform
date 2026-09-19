/**
 * Belépés után a control-plane gyökér mindig máshova redirectel, és a héj
 * nem lehet üres SSR-fallback.
 *
 * Futtatás: npx tsx scripts/default-agent-workspace.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  homePathForAuthContext,
} from '../src/lib/control-plane-entry'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const src = readFileSync(resolve(process.cwd(), 'src/lib/default-agent-workspace.ts'), 'utf8')
const entrySrc = readFileSync(resolve(process.cwd(), 'src/lib/control-plane-entry.ts'), 'utf8')
const rootPage = readFileSync(resolve(process.cwd(), 'src/app/control-plane/page.tsx'), 'utf8')
const pendingPage = readFileSync(resolve(process.cwd(), 'src/app/control-plane/pending/page.tsx'), 'utf8')
const shell = readFileSync(resolve(process.cwd(), 'src/app/control-plane/control-plane-shell.tsx'), 'utf8')
const appShell = readFileSync(resolve(process.cwd(), 'src/components/ui/shell.tsx'), 'utf8')
const rootLoading = readFileSync(resolve(process.cwd(), 'src/app/loading.tsx'), 'utf8')

check('a fallback a munkatárs-lista, nem a gyökér és nem a törölt board', () => {
  assert.equal(DEFAULT_AGENT_WORKSPACE_FALLBACK, '/control-plane/agents')
  assert.match(
    entrySrc,
    /export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '\/control-plane\/agents'/,
  )
  assert.doesNotMatch(entrySrc, /return ['"]\/control-plane['"]/)
  assert.doesNotMatch(src, /\/control-plane\/board/)
})

check('a gyökér-oldal a resolveren keresztül redirectel, nem hardcode-olt önmagára', () => {
  assert.match(rootPage, /redirect\(await resolveDefaultAgentWorkspacePath\(\)\)/)
  assert.doesNotMatch(rootPage, /redirect\('\/control-plane'\)/)
})

check('a resolver minden üres ágon a fallback konstanst adja vissza', () => {
  assert.match(src, /return DEFAULT_AGENT_WORKSPACE_FALLBACK/)
})

check('platform-mód a tenant-registryre megy, ne a munkatárs-listára', () => {
  assert.equal(
    homePathForAuthContext({
      kind: 'platform',
      user: { status: 'active', role: 'admin' },
    }),
    CONTROL_PLANE_PLATFORM_HOME,
  )
})

check('tenant nélküli aktív fiók pendingre megy, ne a listára', () => {
  assert.equal(
    homePathForAuthContext({
      kind: 'none',
      user: { status: 'active', role: 'operator' },
    }),
    CONTROL_PLANE_PENDING_PATH,
  )
})

check('jóváhagyásra váró fiók pendingre megy', () => {
  assert.equal(
    homePathForAuthContext({
      kind: 'none',
      user: { status: 'pending', role: null },
    }),
    CONTROL_PLANE_PENDING_PATH,
  )
})

check('tenant-kontextusban a resolver az első agent felé mehet (null = folytasd)', () => {
  assert.equal(
    homePathForAuthContext({
      kind: 'tenant',
      user: { status: 'active', role: 'operator' },
    }),
    null,
  )
})

check('nincs session → belépő, ne a control-plane gyökérre', () => {
  assert.equal(homePathForAuthContext(null), '/sign-in')
})

check('a pending oldal nem küld vissza minden aktív szerepű usert a gyökérre', () => {
  assert.doesNotMatch(pendingPage, /user\.status === 'active' && user\.role/)
  assert.match(pendingPage, /ctx\?\.kind === 'tenant'/)
  assert.match(pendingPage, /ctx\?\.kind === 'platform'/)
})

check('a control-plane héj nem nyeli el a SSR-t üres Suspense fallbackkel', () => {
  assert.doesNotMatch(shell, /fallback=\{null\}/)
  assert.doesNotMatch(shell, /<Suspense/)
})

check('az AppShell nem suspendel useSearchParams miatt a teljes héjon', () => {
  assert.doesNotMatch(appShell, /useSearchParams/)
})

check('van gyökér betöltő képernyő, ne krém-üres első festés', () => {
  assert.match(rootLoading, /Betöltés/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
