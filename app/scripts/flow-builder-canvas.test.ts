/**
 * Determinisztikus unit-teszt a Governed Flow Builder MAGJÁHOZ (spec ⇄ canvas, D1/D2, WP-2/3/8).
 * Futtatás: npm run test:flow-builder-canvas — DB és böngésző NÉLKÜL.
 *
 * Igazolja:
 *   - specToCanvasModel: start/step/gate/end node + entry/flow/gate/requires/end élek,
 *   - a layout NEM része a spec-nek (contentHash független a node-pozíciótól, D2),
 *   - connect/delete/add/insertTemplate spec-műveletek helyessége és tisztasága (nem mutálnak),
 *   - a paletta-műveletek eredménye Zod-séma-valid marad.
 */
import assert from 'node:assert/strict'
import {
  specToCanvasModel,
  extractLayout,
  computeAutoLayout,
  isDecisionStep,
  START_NODE_ID,
  END_NODE_ID,
} from '../src/lib/playbook-v2/canvas-mapping'
import {
  addStep,
  addGate,
  insertTemplateFragment,
  connectNodes,
  deleteEdgeFromSpec,
  deleteNodeFromSpec,
  replaceGate,
} from '../src/lib/playbook-v2/canvas-spec-ops'
import { parsePlaybookSpecV2, computePlaybookContentHash } from '../src/lib/playbook-v2/spec'
import type { PlaybookDraftSpec } from '../src/components/playbooks/playbook-spec-shared'
import { STARTER_STEP_TEMPLATES } from '../src/domain/step-template/step-template-catalog'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
  }
}

function baseSpec(): PlaybookDraftSpec {
  return {
    schemaVersion: '1.0',
    key: 'test',
    name: 'Test',
    processType: 'test',
    entryStepId: 'a',
    roles: [{ key: 'worker', type: 'agent_role' }],
    steps: [{ id: 'a', name: 'A', ticketType: 'agent_task', assignedRole: 'worker' }],
    gates: [],
    transitions: [],
  } as unknown as PlaybookDraftSpec
}

console.log('Flow Builder — canvas-mag')

check('specToCanvasModel: start + step + end node és entry/end él', () => {
  const model = specToCanvasModel(baseSpec(), null)
  const ids = model.nodes.map((n) => n.id)
  assert.ok(ids.includes(START_NODE_ID), 'van start node')
  assert.ok(ids.includes(END_NODE_ID), 'van end node')
  assert.ok(ids.includes('a'), 'van "a" step node')
  assert.ok(model.edges.some((e) => e.kind === 'entry' && e.target === 'a'), 'start→a entry él')
  assert.ok(model.edges.some((e) => e.kind === 'end' && e.source === 'a'), 'a→end terminál él')
})

check('layout független a contentHash-től (D2)', () => {
  const spec = baseSpec()
  const hashBefore = computePlaybookContentHash(spec)
  // "Node arrébb húzása" = csak layout; a spec érintetlen.
  const layout = { nodes: { a: { x: 999, y: 42 }, [START_NODE_ID]: { x: 1, y: 1 } } }
  const model = specToCanvasModel(spec, layout)
  const aNode = model.nodes.find((n) => n.id === 'a')
  assert.equal(aNode?.position.x, 999, 'a stored layoutból pozicionál')
  assert.equal(computePlaybookContentHash(spec), hashBefore, 'a spec hash változatlan')
})

check('computeAutoLayout: minden step/gate kap pozíciót', () => {
  const spec = baseSpec()
  const pos = computeAutoLayout(spec)
  assert.ok(pos['a'], 'a kapott pozíciót')
})

check('connectNodes: step→step default onComplete routing', () => {
  let spec = addStep(baseSpec(), 'agent').spec
  const bId = (spec.steps ?? []).find((s) => s.id !== 'a')!.id as string
  const before = JSON.stringify(spec)
  const next = connectNodes(spec, 'a', bId)
  assert.equal(JSON.stringify(spec), before, 'connect nem mutálja az inputot (tiszta)')
  const stepA = (next.steps ?? []).find((s) => s.id === 'a')!
  assert.ok(
    (stepA.onComplete ?? []).some((r) => r.nextStepId === bId),
    'a-nak lett onComplete → b',
  )
})

check('connectNodes: start→step átállítja az entry-t', () => {
  const spec = addStep(baseSpec(), 'agent').spec
  const bId = (spec.steps ?? []).find((s) => s.id !== 'a')!.id as string
  const next = connectNodes(spec, START_NODE_ID, bId)
  assert.equal((next as { entryStepId?: string }).entryStepId, bId)
})

check('connectNodes: step→gate requiredGateIds-be kerül', () => {
  const withGate = addGate(baseSpec())
  const gid = withGate.id
  const next = connectNodes(withGate.spec, 'a', gid)
  const stepA = (next.steps ?? []).find((s) => s.id === 'a')!
  assert.ok((stepA.requiredGateIds ?? []).includes(gid))
})

check('deleteEdgeFromSpec: onComplete szabály eltávolítása ruleIndex szerint', () => {
  let spec = addStep(baseSpec(), 'agent').spec
  const bId = (spec.steps ?? []).find((s) => s.id !== 'a')!.id as string
  spec = connectNodes(spec, 'a', bId)
  const model = specToCanvasModel(spec, null)
  const flowEdge = model.edges.find((e) => e.source === 'a' && e.target === bId)!
  assert.ok(flowEdge, 'van a→b él')
  const next = deleteEdgeFromSpec(spec, {
    source: flowEdge.source,
    target: flowEdge.target,
    kind: flowEdge.kind,
    ruleIndex: flowEdge.ruleIndex,
  })
  const stepA = (next.steps ?? []).find((s) => s.id === 'a')!
  assert.ok(!(stepA.onComplete ?? []).some((r) => r.nextStepId === bId), 'a→b él törölve')
})

check('deleteNodeFromSpec: step + referenciák tisztítása, entry újraválasztás', () => {
  let spec = addStep(baseSpec(), 'agent').spec
  const bId = (spec.steps ?? []).find((s) => s.id !== 'a')!.id as string
  spec = connectNodes(spec, 'a', bId)
  const next = deleteNodeFromSpec(spec, 'a')
  assert.ok(!(next.steps ?? []).some((s) => s.id === 'a'), 'a törölve')
  assert.equal((next as { entryStepId?: string }).entryStepId, bId, 'entry átállt b-re')
})

check('addStep (agent/human/decision) séma-valid specet ad', () => {
  for (const kind of ['agent', 'human', 'decision'] as const) {
    const { spec, id } = addStep(baseSpec(), kind)
    assert.doesNotThrow(() => parsePlaybookSpecV2(spec), `${kind} step séma-valid`)
    assert.ok((spec.steps ?? []).some((s) => s.id === id), 'új step benne van')
  }
})

check('addStep(decision) döntési lépésként ismerhető fel', () => {
  const { spec, id } = addStep(baseSpec(), 'decision')
  const step = (spec.steps ?? []).find((s) => s.id === id)!
  assert.ok(isDecisionStep(step), 'decision output-contract → isDecisionStep true')
})

check('insertTemplateFragment: placeholder + role feloldás + gate beszúrás', () => {
  const tmpl = STARTER_STEP_TEMPLATES.find((t) => t.key === 'payment-reconciliation-reviewer')!
  const { spec, id } = insertTemplateFragment(baseSpec(), tmpl.fragment)
  const step = (spec.steps ?? []).find((s) => s.id === id)!
  assert.notEqual(step.assignedRole, '__ROLE__', 'role placeholder feloldva')
  assert.ok(
    (spec.roles ?? []).some((r) => r.key === step.assignedRole),
    'a role felvéve a roles-ba',
  )
  assert.ok((step.requiredGateIds ?? []).length === 1, 'ajánlott gate bekötve')
  assert.ok(
    (spec.gates ?? []).some((g) => g.id === step.requiredGateIds![0]),
    'a gate felvéve a gates-be',
  )
  assert.doesNotThrow(() => parsePlaybookSpecV2(spec), 'template-beszúrás séma-valid')
})

check('replaceGate: kapu cseréje id szerint', () => {
  const withGate = addGate(baseSpec())
  const gid = withGate.id
  const next = replaceGate(withGate.spec, gid, {
    id: gid,
    type: 'human_approval',
    blocking: true,
    criticality: 'L3',
  })
  const gate = (next.gates ?? []).find((g) => g.id === gid)!
  assert.equal(gate.criticality, 'L3')
})

check('extractLayout: pozíciók kinyerése kerekítve', () => {
  const nodes = [
    { id: 'a', position: { x: 12.4, y: 8.9 } },
    { id: START_NODE_ID, position: { x: 0.2, y: 0.7 } },
  ]
  const layout = extractLayout(nodes, { x: 0, y: 0, zoom: 1 })
  assert.equal(layout.nodes!['a'].x, 12)
  assert.equal(layout.nodes!['a'].y, 9)
  assert.deepEqual(layout.viewport, { x: 0, y: 0, zoom: 1 })
})

console.log(failures === 0 ? '\nMinden teszt zöld ✓' : `\n${failures} teszt bukott ✗`)
process.exit(failures === 0 ? 0 : 1)
