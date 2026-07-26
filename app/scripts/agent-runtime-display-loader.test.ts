/**
 * Contract: findByIdForRuntime vs findByIdForDisplay — a runtime útvonal
 * nem kér versions / apiKeys / resources include-ot (perf P1).
 *
 * DB nélkül: a repository forrásában ellenőrzi a két loader Prisma include
 * alakját, és hogy a withDetails alias a displayre mutat.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoSrc = readFileSync(join(root, 'src/repositories/postgres/agent-repository.ts'), 'utf8')
const ifaceSrc = readFileSync(join(root, 'src/repositories/interfaces/index.ts'), 'utf8')

function extractMethodBody(src: string, methodName: string): string {
  const start = src.indexOf(`async ${methodName}(`)
  assert.ok(start >= 0, `missing method ${methodName}`)
  const brace = src.indexOf('{', start)
  assert.ok(brace >= 0, `missing body for ${methodName}`)
  let depth = 0
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(brace, i + 1)
    }
  }
  throw new Error(`unclosed body for ${methodName}`)
}

const runtimeBody = extractMethodBody(repoSrc, 'findByIdForRuntime')
const displayBody = extractMethodBody(repoSrc, 'findByIdForDisplay')
const withDetailsBody = extractMethodBody(repoSrc, 'findByIdWithDetails')

assert.match(runtimeBody, /currentVersion:\s*true/, 'runtime loads current memory version')
assert.doesNotMatch(runtimeBody, /versions\s*:/, 'runtime must not load memory.versions list')
assert.doesNotMatch(runtimeBody, /apiKeys\s*:/, 'runtime must not load apiKeys')
assert.doesNotMatch(runtimeBody, /agentResources\s*:/, 'runtime must not load resources')
assert.doesNotMatch(runtimeBody, /behaviorProfileRef\s*:/, 'runtime must not load behavior profile')
assert.doesNotMatch(runtimeBody, /recipeVersion/, 'runtime must not load recipe')

assert.match(displayBody, /versions\s*:/, 'display loads memory.versions for UI')
assert.match(displayBody, /apiKeys\s*:/, 'display loads apiKeys for preview')
assert.match(displayBody, /agentResources\s*:/, 'display loads resources')
assert.match(displayBody, /behaviorProfileRef\s*:/, 'display loads behavior profile')
assert.match(displayBody, /recipeVersion/, 'display loads recipe')

assert.match(withDetailsBody, /findByIdForDisplay/, 'withDetails stays a display alias')

assert.match(ifaceSrc, /findByIdForRuntime/, 'interface exports runtime loader')
assert.match(ifaceSrc, /findByIdForDisplay/, 'interface exports display loader')
assert.match(ifaceSrc, /export type AgentRuntimeDetails/, 'AgentRuntimeDetails type present')
assert.match(ifaceSrc, /export type AgentDisplayDetails/, 'AgentDisplayDetails type present')

// Hot-path callers must use the runtime loader.
const hotPaths = [
  'src/domain/tool-broker/tool-broker-delegation.ts',
  'src/domain/agent/agent-chat-runtime.ts',
  'src/domain/agent/general-task-runtime.ts',
  'src/domain/agent/bookkeeper-runtime.ts',
]
for (const rel of hotPaths) {
  const src = readFileSync(join(root, rel), 'utf8')
  assert.match(src, /findByIdForRuntime/, `${rel} uses findByIdForRuntime`)
  assert.doesNotMatch(
    src,
    /findByIdWithDetails|findByIdForDisplay/,
    `${rel} must not use display/withDetails loader`,
  )
}

// UI / wiki keep the rich display loader.
const displayPaths = [
  'src/lib/agent-detail-page-data.ts',
  'src/lib/agent-catalog.ts',
  'src/domain/agent/wiki-runtime.ts',
]
for (const rel of displayPaths) {
  const src = readFileSync(join(root, rel), 'utf8')
  assert.match(src, /findByIdForDisplay/, `${rel} uses findByIdForDisplay`)
}

console.log('OK — agent runtime/display loader contract (15 checks)')
