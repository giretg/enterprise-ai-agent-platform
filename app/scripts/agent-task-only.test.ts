/**
 * issue #199 — Feladatkör-korlátozás (taskOnly agent).
 *
 * A lefedett szabályok:
 *   1) csatolmány-flag: alapérték engedett, clamp/aggregálás/diff/SKILL.md import,
 *   2) korlátozott feladat-bemenet validációja (leírás tiltva, pontosan 1 skill,
 *      ismeretlen paraméter-kulcs),
 *   3) szerveroldalon generált cím + a cím helyett használt feladat-szöveg,
 *   4) skill-paraméterek renderelése a promptba (deklaráció + kitöltött értékek).
 *
 * Run: npx tsx scripts/agent-task-only.test.ts
 */
import assert from 'node:assert/strict'

import {
  aggregateSkillRuntimeHints,
  clampSkillRuntimeHints,
  parseSkillContent,
  skillAllowsAttachments,
} from '../src/lib/skill/skill-content'
import { diffSkillVersions } from '../src/lib/skill/skill-diff'
import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import {
  buildLoadedSkillPrompt,
  formatSkillParameterValuesPrompt,
} from '../src/lib/skill/skill-context'
import {
  buildTaskOnlyTaskPrompt,
  buildTaskOnlyTicketTitle,
  readTicketPreferredSkillVersionIds,
  validateTaskOnlyTaskInput,
} from '../src/lib/task-only-ticket'
import { SkillService } from '../src/domain/skill/skill-service'
import { createBoardTicketSchema } from '../src/lib/validators/actions'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ❌ ${name}`)
    console.error(error)
  }
}

console.log('\n#199 — Feladatkör-korlátozás\n')

// ── 1. Csatolmány-flag ───────────────────────────────────────────────────────

test('skillAllowsAttachments: hiányzó érték = engedett (visszafelé kompatibilitás)', () => {
  assert.equal(skillAllowsAttachments(undefined), true)
  assert.equal(skillAllowsAttachments(null), true)
  assert.equal(skillAllowsAttachments({}), true)
  assert.equal(skillAllowsAttachments({ allowAttachments: true }), true)
  assert.equal(skillAllowsAttachments({ allowAttachments: false }), false)
})

test('skillAllowsAttachments: a meglévő, hint nélküli skillek nem változnak', () => {
  const legacy = parseSkillContent({ instructions: ['Csinálj valamit.'] })
  assert.equal(skillAllowsAttachments(legacy.runtimeHints), true)
})

test('aggregateSkillRuntimeHints: egyetlen tiltó skill is letiltja a csatolást', () => {
  const aggregated = aggregateSkillRuntimeHints([
    { allowAttachments: true },
    { maxToolCalls: 100 },
    { allowAttachments: false },
  ])
  assert.equal(aggregated?.allowAttachments, false)
  assert.equal(aggregated?.maxToolCalls, 100)
})

test('aggregateSkillRuntimeHints: csupa megengedő skillnél nem jelenik meg a mező', () => {
  const aggregated = aggregateSkillRuntimeHints([{ allowAttachments: true }, {}])
  assert.equal(aggregated, undefined)
})

test('clampSkillRuntimeHints: csak a TILTÁST tárolja el', () => {
  assert.equal(clampSkillRuntimeHints({ allowAttachments: true }), undefined)
  assert.deepEqual(clampSkillRuntimeHints({ allowAttachments: false }), {
    allowAttachments: false,
  })
})

test('diffSkillVersions: a csatolmány-tiltás megjelenik a verzió-diffben', () => {
  const before = parseSkillContent({ instructions: ['a'] })
  const after = parseSkillContent({
    instructions: ['a'],
    runtimeHints: { allowAttachments: false },
  })
  const diff = diffSkillVersions(
    { content: before, requires: [] },
    { content: after, requires: [] },
  )
  const change = diff.changes.find((c) => c.detail.startsWith('allowAttachments'))
  assert.ok(change, 'a diffnek jeleznie kell az allowAttachments változást')
  assert.match(change.detail, /engedett \(alapérték\) → tiltott/)
})

test('SKILL.md import: `allow-attachments: false` átjön a runtimeHints-be', () => {
  const parsed = parseSkillMd(
    ['---', 'name: Számlafeldolgozás', 'allow-attachments: false', '---', '', '# Lépések'].join(
      '\n',
    ),
  )
  assert.equal(parsed.content.runtimeHints?.allowAttachments, false)
  assert.equal(skillAllowsAttachments(parsed.content.runtimeHints), false)
})

test('SKILL.md import: `allow-attachments: true` nem zajosítja a hasht', () => {
  const parsed = parseSkillMd(
    ['---', 'name: Számlafeldolgozás', 'allow-attachments: true', '---', '', 'Törzs'].join('\n'),
  )
  assert.equal(parsed.content.runtimeHints, undefined)
})

test('clampSkillRuntimeHints: csatolmány-leírás trimmelve és mentve', () => {
  assert.deepEqual(
    clampSkillRuntimeHints({ attachmentDescription: '  Excel táblázat  ' }),
    { attachmentDescription: 'Excel táblázat' },
  )
  assert.equal(clampSkillRuntimeHints({ attachmentDescription: '   ' }), undefined)
})

test('clampSkillRuntimeHints: csatolmány-tiltásnál a leírás nem kerül mentésre', () => {
  assert.deepEqual(
    clampSkillRuntimeHints({
      allowAttachments: false,
      attachmentDescription: 'Excel táblázat',
    }),
    { allowAttachments: false },
  )
})

test('diffSkillVersions: a csatolmány-leírás megjelenik a verzió-diffben', () => {
  const before = parseSkillContent({ instructions: ['a'] })
  const after = parseSkillContent({
    instructions: ['a'],
    runtimeHints: { attachmentDescription: 'PDF számla' },
  })
  const diff = diffSkillVersions(
    { content: before, requires: [] },
    { content: after, requires: [] },
  )
  const change = diff.changes.find((c) => c.detail.startsWith('attachmentDescription'))
  assert.ok(change, 'a diffnek jeleznie kell az attachmentDescription változást')
  assert.match(change.detail, /PDF számla/)
})

test('SKILL.md import: `attachment-description` átjön a runtimeHints-be', () => {
  const parsed = parseSkillMd(
    [
      '---',
      'name: Számlafeldolgozás',
      'attachment-description: PDF formátumú számla',
      '---',
      '',
      '# Lépések',
    ].join('\n'),
  )
  assert.equal(parsed.content.runtimeHints?.attachmentDescription, 'PDF formátumú számla')
})

// ── 2. Korlátozott feladat-bemenet validációja ───────────────────────────────

test('validateTaskOnlyTaskInput: a szabad szöveges leírás HANGOS hiba', () => {
  const result = validateTaskOnlyTaskInput({
    description: 'Kérlek nézd meg ezt is',
    skillVersionIds: ['v1'],
    declaredParameterNames: [],
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /szabad szöveges feladatleírást/)
})

test('validateTaskOnlyTaskInput: pontosan egy skill kell', () => {
  assert.equal(
    validateTaskOnlyTaskInput({ skillVersionIds: [], declaredParameterNames: [] }).ok,
    false,
  )
  assert.equal(
    validateTaskOnlyTaskInput({ skillVersionIds: ['a', 'b'], declaredParameterNames: [] }).ok,
    false,
  )
  assert.equal(
    validateTaskOnlyTaskInput({ skillVersionIds: ['a'], declaredParameterNames: [] }).ok,
    true,
  )
})

test('validateTaskOnlyTaskInput: ismeretlen paraméter-kulcs hiba', () => {
  const result = validateTaskOnlyTaskInput({
    skillVersionIds: ['v1'],
    skillParameterValues: { hrsz: '1234', kamu: 'x' },
    declaredParameterNames: ['hrsz'],
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /Ismeretlen skill-paraméter: kamu/)
})

test('validateTaskOnlyTaskInput: az üres paraméter kimarad, minden mező opcionális', () => {
  const result = validateTaskOnlyTaskInput({
    skillVersionIds: ['v1'],
    skillParameterValues: { hrsz: '  1234 ', megjegyzes: '   ' },
    declaredParameterNames: ['hrsz', 'megjegyzes'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok === true ? result.parameterValues : null, { hrsz: '1234' })
})

test('createBoardTicketSchema: skillParameterValues csak agent-hozzárendelésnél', () => {
  const human = createBoardTicketSchema.safeParse({
    title: 'Valami',
    assigneeType: 'human',
    assigneeId: '11111111-1111-4111-8111-111111111111',
    skillParameterValues: { a: 'b' },
  })
  assert.equal(human.success, false)

  const agent = createBoardTicketSchema.safeParse({
    title: 'Valami',
    assigneeType: 'agent',
    assigneeId: '11111111-1111-4111-8111-111111111111',
    skillParameterValues: { a: 'b' },
  })
  assert.equal(agent.success, true)
})

test('createBoardTicketSchema: a paraméter-érték hossza korlátos', () => {
  const tooLong = createBoardTicketSchema.safeParse({
    title: 'Valami',
    assigneeType: 'agent',
    assigneeId: '11111111-1111-4111-8111-111111111111',
    skillParameterValues: { a: 'x'.repeat(2_001) },
  })
  assert.equal(tooLong.success, false)
})

// ── 3. Generált cím és feladat-szöveg ────────────────────────────────────────

test('buildTaskOnlyTicketTitle: `<skill neve> — YYYY-MM-DD HH:mm`', () => {
  // 2026-08-01 12:03 UTC = 14:03 Budapesten (nyári időszámítás).
  const title = buildTaskOnlyTicketTitle(
    'Számlafeldolgozás',
    new Date('2026-08-01T12:03:00Z'),
    'Europe/Budapest',
  )
  assert.equal(title, 'Számlafeldolgozás — 2026-08-01 14:03')
})

test('buildTaskOnlyTaskPrompt: a generált cím helyett értelmes feladat-szöveg megy a modellhez', () => {
  const prompt = buildTaskOnlyTaskPrompt('Számlafeldolgozás')
  assert.match(prompt, /"Számlafeldolgozás" skillt/)
  assert.match(prompt, /Szabad szöveges feladatleírás nincs/)
  // A cím-bélyeg NEM kerülhet a promptba: az nem utasítás, hanem azonosító.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(prompt))
})

// ── 4. Skill-paraméterek a promptban ─────────────────────────────────────────

test('buildLoadedSkillPrompt: a deklarált paraméterek eljutnak a modellhez', () => {
  const content = parseSkillContent({
    instructions: ['Dolgozz.'],
    parameters: [{ name: 'hrsz', description: 'Helyrajzi szám' }],
  })
  const prompt = buildLoadedSkillPrompt(
    { skillId: 's1', skillVersionId: 'v1', name: 'Tulajdoni lap', description: '', version: 3 },
    content,
  )
  assert.match(prompt, /hrsz: Helyrajzi szám/)
})

test('formatSkillParameterValuesPrompt: csak a kitöltött mezők, leírással együtt', () => {
  const block = formatSkillParameterValuesPrompt(
    [
      { name: 'hrsz', description: 'Helyrajzi szám' },
      { name: 'megjegyzes', description: 'Egyéb' },
    ],
    { hrsz: '1234/5', megjegyzes: '' },
  )
  assert.match(block, /- hrsz \(Helyrajzi szám\): 1234\/5/)
  assert.ok(!block.includes('megjegyzes'))
})

test('formatSkillParameterValuesPrompt: üres kitöltésnél nincs blokk', () => {
  assert.equal(formatSkillParameterValuesPrompt([{ name: 'a', description: '' }], {}), '')
  assert.equal(formatSkillParameterValuesPrompt([], { a: 'b' }), '')
})

// ── 5. Csatolmány-kapu a feltöltő endpointon ─────────────────────────────────

test('readTicketPreferredSkillVersionIds: fail-safe olvasás a tárolt payloadból', () => {
  assert.deepEqual(readTicketPreferredSkillVersionIds(null), [])
  assert.deepEqual(readTicketPreferredSkillVersionIds({ preferredSkillVersionIds: 'v1' }), [])
  assert.deepEqual(
    readTicketPreferredSkillVersionIds({ preferredSkillVersionIds: ['v1', 'v1', 2, ''] }),
    ['v1'],
  )
})

async function attachmentPolicyFor(
  versions: Array<{ id: string; name: string; allowAttachments?: boolean }>,
) {
  const skillsRepo = {
    findVersionsByIds: async (ids: string[]) =>
      versions
        .filter((v) => ids.includes(v.id))
        .map((v) => ({
          id: v.id,
          skill: { name: v.name },
          content: {
            instructions: [],
            triggerKeywords: [],
            parameters: [],
            ...(v.allowAttachments === false
              ? { runtimeHints: { allowAttachments: false } }
              : {}),
          },
        })),
  }
  const svc = new SkillService(skillsRepo as never, {} as never, {} as never, {} as never)
  return svc.resolveAttachmentPolicy(versions.map((v) => v.id))
}

async function runAttachmentPolicyTests() {
  const allowed = await attachmentPolicyFor([{ id: 'v1', name: 'Számlafeldolgozás' }])
  test('resolveAttachmentPolicy: hint nélküli skill engedi a csatolást', () => {
    assert.equal(allowed.allowAttachments, true)
    assert.deepEqual(allowed.blockingSkillNames, [])
  })

  const blocked = await attachmentPolicyFor([
    { id: 'v1', name: 'Számlafeldolgozás' },
    { id: 'v2', name: 'Heti riport', allowAttachments: false },
  ])
  test('resolveAttachmentPolicy: egyetlen tiltó skill is 403-at okoz, névvel', () => {
    assert.equal(blocked.allowAttachments, false)
    assert.deepEqual(blocked.blockingSkillNames, ['Heti riport'])
  })

  const empty = await attachmentPolicyFor([])
  test('resolveAttachmentPolicy: skill nélküli ticketnél nincs kapu', () => {
    assert.equal(empty.allowAttachments, true)
  })
}

// ── 6. Audit ─────────────────────────────────────────────────────────────────

test('audit event-catalog: az `agent.task_only` esemény regisztrált', () => {
  assert.ok(REGISTERED_AUDIT_ACTIONS.has('agent.task_only'))
})

async function main() {
  await runAttachmentPolicyTests()
  console.log('')
  if (failures > 0) {
    console.error(`${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('Minden teszt zöld.')
  process.exit(0)
}

void main()
