/**
 * A control-plane gyökér mindig redirectel — a fallback nem lehet önmaga.
 * Futtatás: npx tsx scripts/default-agent-workspace.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
const rootPage = readFileSync(resolve(process.cwd(), 'src/app/control-plane/page.tsx'), 'utf8')

check('a fallback a board, nem a gyökér, ami mindig továbbredirectel', () => {
  assert.match(
    src,
    /export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '\/control-plane\/board'/,
  )
  assert.doesNotMatch(src, /return ['"]\/control-plane['"]/)
})

check('a gyökér-oldal a resolveren keresztül redirectel, nem hardcode-olt önmagára', () => {
  assert.match(rootPage, /redirect\(await resolveDefaultAgentWorkspacePath\(\)\)/)
  assert.doesNotMatch(rootPage, /redirect\('\/control-plane'\)/)
})

check('a resolver minden üres ágon a fallback konstanst adja vissza', () => {
  assert.match(src, /return DEFAULT_AGENT_WORKSPACE_FALLBACK/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
