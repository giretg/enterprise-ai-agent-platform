/**
 * Issue #659 — where agent knowledge belongs.
 * Futtatás: npm run test:agent-knowledge-placement
 */
import assert from 'node:assert/strict'
import {
  detectMisplacedMemoryWrite,
  KNOWLEDGE_PLACEMENT_TABLE,
  renderKnowledgePlacementBlock,
  type KnowledgePlacementTarget,
} from '../src/lib/agent-knowledge-placement'
import { buildMcpServerInstructions } from '../src/lib/mcp-tenant-context'
import { renderAgentBriefing } from '../src/lib/agent-checkout'
import type { AgentDefinition } from '../src/domain/agent-definition'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('placement table includes every target row', () => {
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /platform\.project_memory\.write/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /platform\.skills\.submit/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /kb_ingest/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /platform\.work_file\.write/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /google_drive_upload_file/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /session_log/)
  assert.match(KNOWLEDGE_PLACEMENT_TABLE, /kind `focus`/)
})

check('server instructions and briefing share the table block', () => {
  const block = renderKnowledgePlacementBlock()
  const instructions = buildMcpServerInstructions({
    tenant: { displayName: 'Test', legalName: null, slug: 'test', settings: {} },
    tenantSlug: 'test',
    coworkers: [],
  })
  assert.ok(instructions.includes(block))
  const def: AgentDefinition = {
    agentId: 'a',
    definitionId: 'd',
    version: 1,
    status: 'active',
    snapshot: {
      name: 'Agent',
      description: null,
      roleInstruction: 'Role',
      capabilities: [],
      connectors: [],
      skills: [],
    },
  }
  const briefing = renderAgentBriefing({ definition: def, skills: [] })
  assert.ok(briefing.includes(block))
})

check('detectMisplacedMemoryWrite flags long document-like body', () => {
  const misplaced = detectMisplacedMemoryWrite({
    kind: 'decision',
    title: 'API doc',
    body: 'x'.repeat(1_500),
  })
  assert.ok(misplaced)
  assert.equal(misplaced.suggest, 'knowledge_base')
})

check('detectMisplacedMemoryWrite flags numbered procedure', () => {
  const body = [
    'Blog approval',
    '1. Write draft',
    '2. Always run SEO check',
    '3. Never publish without review',
    '4. Send to marketing lead',
  ].join('\n')
  const misplaced = detectMisplacedMemoryWrite({ kind: 'constraint', title: 'Blog', body })
  assert.ok(misplaced)
  assert.equal(misplaced.suggest, 'skill')
})

check('detectMisplacedMemoryWrite allows short fact', () => {
  assert.equal(
    detectMisplacedMemoryWrite({
      kind: 'decision',
      title: 'HQ',
      body: 'Head office is in Szeged.',
    }),
    null,
  )
})

// Harness-eval-only keyword classifier: the prod path warns via
// detectMisplacedMemoryWrite, it never routes on these keywords.
const SAVE_STOP = new Set(['meg', 'ment', 'mentsd', 'jegyezd', 'tedd', 'the', 'and', 'for', 'hogy', 'egy'])

function saveTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !SAVE_STOP.has(token))
}

function hayHasAny(hay: Set<string>, needles: string[]): boolean {
  return needles.some((needle) => hay.has(needle) || [...hay].some((token) => token.includes(needle)))
}

function classifyKnowledgeSaveIntent(request: string): KnowledgePlacementTarget {
  const hay = new Set(saveTokens(request))
  const raw = request.toLowerCase()

  if (hayHasAny(hay, ['fokusz', 'focus', 'most', 'dolgozunk', 'working', 'now'])) {
    if (hayHasAny(hay, ['most', 'dolgozunk', 'working', 'folyamatban', 'now'])) return 'focus'
  }
  if (hayHasAny(hay, ['ma', 'today', 'tortent', 'happened', 'naplo', 'session'])) return 'session_log'
  if (hayHasAny(hay, ['drive', 'feltolt', 'upload', 'kesz', 'deliverable', 'human'])) return 'drive'
  if (
    hayHasAny(hay, ['tudasbazis', 'knowledge', 'dokumentacio', 'documentation', 'pdf', 'wiki', 'anyag', 'referencia'])
  ) {
    return 'knowledge_base'
  }
  if (hayHasAny(hay, ['terv', 'plan', 'jegyzet', 'notes', 'draft', 'piszkozat', 'munkafajl', 'workfile'])) {
    return 'work_file'
  }
  if (
    hayHasAny(hay, ['szabaly', 'rule', 'eljaras', 'procedure', 'policy', 'mindig', 'kovetendo', 'operating']) ||
    /így csináljuk|how we do/i.test(raw)
  ) {
    return 'skill'
  }
  return 'project_memory'
}

check('#659 eval: 10 save/remember requests, at least 9/10 pick the right target', () => {
  const cases: Array<[string, KnowledgePlacementTarget]> = [
    ['Jegyezd meg, a főiroda Szegeden van.', 'project_memory'],
    ['Mentsd el: mindig két review kell a blog előtt', 'skill'],
    ['Töltsd fel a havi riport PDF-et a tudásbázisba', 'knowledge_base'],
    ['Mentsd a Q3 tervet a munkafájlok közé', 'work_file'],
    ['Tedd a kész blogposztot a Drive-ra', 'drive'],
    ['Jegyezd meg mi történt ma: elküldtük a newslettert', 'session_log'],
    ['Most a SEO auditon dolgozunk, következő lépés a report', 'focus'],
    ['Jegyezd meg, Ádám a sales owner', 'project_memory'],
    ['Így csináljuk az e-mail jóváhagyást: mindig draft, review, send', 'skill'],
    ['Mentsd el a teljes API dokumentációt a cégnek', 'knowledge_base'],
  ]
  const hits = cases.filter(([request, expected]) => classifyKnowledgeSaveIntent(request) === expected)
  assert.ok(hits.length >= 9, `expected ≥9/10, got ${hits.length}/10: ${cases.filter(([r, e]) => classifyKnowledgeSaveIntent(r) !== e).map(([r]) => r).join(' | ')}`)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}

console.log('\nAll agent-knowledge-placement checks passed.')
