/**
 * A "Megnézem, mit változtat" gomb kliens-oldali előnézete.
 * Futtatás: npm run test:training-preview-client
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  clearTrainingPreviewSession,
  forgetTrainingPreviewMemory,
  previewStateFromActionData,
  readTrainingPreviewSession,
  subscribeTrainingPreview,
  writeTrainingPreviewSession,
} from '../src/components/agents/training-preview-session'
import type { ChangeSummary, ImpactResult } from '../src/domain/training/training-composition'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const changeSummary: ChangeSummary = {
  added: ['A riportokban sötét-kéket használj'],
  removed: [],
  unchanged: ['HTML-ben készítsd a riportot'],
  rewritten: [],
}

const impactResult: ImpactResult = {
  verdict: 'complements',
  added: changeSummary.added,
  rewritten: [],
  removed: [],
  hardFloor: { blocked: false },
  nextStep: null,
}

const preview = {
  previewId: 'token.sig',
  proposedVersion: 'HTML-ben készítsd a riportot\nA riportokban sötét-kéket használj',
  changeSummary,
  impactResult,
}

test('az action payload JSON-on átmenve is preview-state', () => {
  const serialized = JSON.parse(JSON.stringify(preview)) as unknown
  const parsed = previewStateFromActionData(serialized)
  assert.deepEqual(parsed, preview)
})

test('hiányos action payload nem jelenik meg üres kártyaként', () => {
  assert.equal(previewStateFromActionData({ success: true }), null)
  assert.equal(previewStateFromActionData({ previewId: 'x' }), null)
  assert.equal(previewStateFromActionData(undefined), null)
})

test('üres session ugyanaz a referencia — ne indítson végtelen renderciklust', () => {
  assert.equal(readTrainingPreviewSession('missing-a'), readTrainingPreviewSession('missing-b'))
})

test('a session túléli a komponens újramountolását', () => {
  const agentId = 'aac816cb-09f9-46d1-936f-c0d736377791'
  clearTrainingPreviewSession(agentId)
  writeTrainingPreviewSession(agentId, { preview, error: null })
  assert.deepEqual(readTrainingPreviewSession(agentId).preview, preview)
  clearTrainingPreviewSession(agentId)
  assert.equal(readTrainingPreviewSession(agentId).preview, null)
})

test('a session és a piszkozat túléli az oldalfrissítést', () => {
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
      removeItem: (key: string) => {
        memory.delete(key)
      },
      clear: () => memory.clear(),
      key: () => null,
      get length() {
        return memory.size
      },
    },
  })
  const agentId = 'cccccccc-09f9-46d1-936f-c0d736377791'
  clearTrainingPreviewSession(agentId)
  writeTrainingPreviewSession(agentId, { preview, error: null, draft: 'lila és sárga' })
  forgetTrainingPreviewMemory()
  const restored = readTrainingPreviewSession(agentId)
  assert.equal(restored.preview?.previewId, preview.previewId)
  assert.equal(restored.draft, 'lila és sárga')
  clearTrainingPreviewSession(agentId)
})

test('a session írása értesíti a feliratkozót — remount közben is megjön az eredmény', () => {
  const agentId = 'bbbbbbbb-09f9-46d1-936f-c0d736377791'
  let calls = 0
  const stop = subscribeTrainingPreview(() => {
    calls += 1
  })
  writeTrainingPreviewSession(agentId, { preview, error: null })
  assert.equal(calls, 1)
  assert.equal(readTrainingPreviewSession(agentId).preview?.previewId, preview.previewId)
  stop()
  writeTrainingPreviewSession(agentId, { preview: null, error: 'x' })
  assert.equal(calls, 1)
  clearTrainingPreviewSession(agentId)
})

test('a beépítem/lecserélem választó csak látható függő javaslattal jelenik meg, és a javaslatot is mutatja', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../src/components/agents/training-workspace.tsx'),
    'utf8',
  )
  assert.match(src, /const showCompositionChoice = Boolean\(workspace\?\.pendingProposal\)/)
  const fieldsetStart = src.indexOf('{showCompositionChoice && workspace?.pendingProposal && (')
  assert.ok(fieldsetStart >= 0, 'a választó pendingProposal-hoz van kötve')
  const window = src.slice(fieldsetStart, fieldsetStart + 2800)
  assert.match(window, /Ebbe a függő javaslatba építenél, vagy ezt cserélnéd le/)
  assert.match(window, /Beépítem a meglévő javaslatba/)
  assert.match(window, /Lecserélem a meglévő javaslatot/)
  assert.match(src, /Elemzem a meglévő szabályokat/)
  assert.match(src, /<Spinner/)
  assert.match(src, /Régi szabály/)
  assert.match(src, /Új szabály/)
  assert.match(src, /Tanítási ticket létrejött/)
  assert.match(src, /Ticket megnyitása/)
  assert.match(src, /A javasolt teljes szabályverzió/)
})

test('a tanítás előnézete nem startTransition(async) + setState a server action után', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../src/components/agents/training-workspace.tsx'),
    'utf8',
  )
  const start = src.indexOf('function runPreview')
  const end = src.indexOf('function runSubmit')
  assert.ok(start >= 0 && end > start, 'runPreview / runSubmit nem található')
  const runPreview = src.slice(start, end)
  assert.doesNotMatch(
    runPreview,
    /startTransition\(/,
    'a preview setState-et a server action RSC-refresh eldobja, ha startTransition(async) wrappingben van',
  )
  assert.match(runPreview, /await previewTrainingChange/)
  assert.match(runPreview, /writeTrainingPreviewSession/)
  assert.match(runPreview, /previewStateFromActionData/)
  assert.match(src, /useTrainingPreviewSession/)
  const submitStart = src.indexOf('async function runSubmit')
  const submitEnd = src.indexOf('return (', submitStart)
  assert.ok(submitStart >= 0 && submitEnd > submitStart)
  const runSubmit = src.slice(submitStart, submitEnd)
  assert.doesNotMatch(runSubmit, /startTransition\(/)
  assert.match(runSubmit, /setSubmitResult/)
})

test('a javaslat visszaküldése in-app modal, opcionális indokkal, nem window.prompt', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../src/components/agents/training-workspace.tsx'),
    'utf8',
  )
  assert.doesNotMatch(src, /\bprompt\s*\(/, 'a natív window.prompt-ot in-app modal váltja')
  assert.match(src, /function TrainingRejectModal/)
  assert.match(src, /createPortal/)
  assert.match(src, /document\.body/)
  assert.match(src, /Indoklás \(opcionális\)/)
  assert.match(src, /a ticket állapot-előzményében jelenik meg/)
  assert.match(src, /setRejectDialog/)
  assert.doesNotMatch(
    src,
    /if \(!reason\?\.trim\(\)\) return/,
    'üres indokkal is beküldhető a visszaküldés',
  )
  const schemaSrc = readFileSync(
    resolve(import.meta.dirname, '../src/lib/validators/actions.ts'),
    'utf8',
  )
  const schemaStart = schemaSrc.indexOf('export const rejectTrainingSchema')
  const schemaEnd = schemaSrc.indexOf('export const getTrainingWorkspaceSchema')
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart, 'rejectTrainingSchema nem található')
  const schema = schemaSrc.slice(schemaStart, schemaEnd)
  assert.match(schema, /reason: z\.string\(\)\.trim\(\)\.max\(500\)\.optional\(\)/)
  assert.doesNotMatch(schema, /\.min\(1\)/)
})

test('a preview action JSON-ként tér vissza, nem nyers objektumként', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../src/app/actions/platform.ts'),
    'utf8',
  )
  const start = src.indexOf('export async function previewTrainingChange')
  const end = src.indexOf('export async function submitTrainingProposal')
  assert.ok(start >= 0 && end > start, 'previewTrainingChange nem található')
  const fn = src.slice(start, end)
  assert.match(fn, /JSON\.parse\(\s*JSON\.stringify/)
  assert.match(fn, /previewId: data\.previewId/)
  assert.match(fn, /changeSummary: data\.changeSummary/)
  assert.match(fn, /impactResult: data\.impactResult/)
})

if (failures > 0) {
  console.error(`\n${failures} training-preview-client teszt piros`)
  process.exit(1)
}
console.log('\nÖsszes training-preview-client teszt zöld')
