/**
 * #957 WP-1: az agent-adatlap minden beállítási területe elérhető a
 * varázslóból, vagy kifejezett indokkal marad ki. Ha az adatlapra új
 * beállító komponens kerül besorolás nélkül, ez a teszt elbukik.
 *
 * Futtatás: npm run test:agent-setting-sections
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_DETAIL_SECTION_IDS } from '../src/lib/agent-detail-sections'
import {
  AGENT_SETTING_SECTIONS,
  settingSectionsForWizardStep,
  type AgentSettingSection,
} from '../src/lib/agent-setting-sections'
import { CREATE_AGENT_WIZARD_STEPS } from '../src/lib/create-agent-wizard'

const root = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

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

const sections = AGENT_SETTING_SECTIONS as readonly AgentSettingSection[]
const detailPage = read('src/app/control-plane/agents/[agentId]/page.tsx')
const hireDir = 'src/components/agents/hire'
const wizardSources = [
  read('src/components/agents/create-agent-wizard.tsx'),
  ...readdirSync(resolve(root, hireDir))
    .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
    .map((file) => read(`${hireDir}/${file}`)),
].join('\n')

/** Az adatlapon renderelt beállító komponensek (fejléc-gombok nélkül). */
function detailSettingComponents(): string[] {
  const names = new Set<string>()
  const re = /<((?:Update\w+Form)|(?:Agent\w+(?:Panel|Upload|Browser|Form))|ClientPolicyForm|PublishAgentDefinitionForm)\b/g
  for (const match of detailPage.matchAll(re)) names.add(match[1])
  return [...names]
}

check('minden adatlap-szekcióhoz van legalább egy beállítás-jegyzék sor', () => {
  for (const id of AGENT_DETAIL_SECTION_IDS) {
    assert.ok(
      sections.some((section) => section.detailSection === id),
      `az adatlap „${id}” szekciója nincs a jegyzékben`,
    )
  }
})

check('minden sor vagy varázsló-lépést, vagy kihagyási indokot ad (pontosan egyet)', () => {
  const stepIds = new Set<string>(CREATE_AGENT_WIZARD_STEPS.map((step) => step.id))
  for (const section of sections) {
    const hasStep = Boolean(section.wizardStep)
    const hasReason = Boolean(section.wizardSkipReason?.trim())
    assert.notEqual(hasStep, hasReason, `${section.id}: wizardStep XOR wizardSkipReason`)
    if (section.wizardStep) {
      assert.ok(stepIds.has(section.wizardStep), `${section.id}: ismeretlen lépés ${section.wizardStep}`)
      assert.ok((section.wizardUses?.length ?? 0) > 0, `${section.id}: wizardUses kötelező`)
    }
  }
})

check('a jegyzék azonosítói egyediek', () => {
  const ids = sections.map((section) => section.id)
  assert.equal(new Set(ids).size, ids.length)
})

check('az adatlap minden beállító komponense szerepel a jegyzékben', () => {
  const registered = new Set(sections.map((section) => section.detailComponent))
  const found = detailSettingComponents()
  assert.ok(found.length >= 10, `túl kevés komponenst találtunk (${found.length}) — a minta elavult?`)
  for (const component of found) {
    assert.ok(
      registered.has(component),
      `az adatlapon új beállító komponens van varázslós besorolás nélkül: ${component}`,
    )
  }
})

check('a jegyzék komponensei valóban az adatlapon vannak', () => {
  for (const section of sections) {
    assert.match(detailPage, new RegExp(`<${section.detailComponent}\\b`), section.detailComponent)
  }
})

check('a varázsló ugyanazokat a komponenseket / mentési műveleteket használja', () => {
  for (const section of sections) {
    for (const name of section.wizardUses ?? []) {
      assert.match(wizardSources, new RegExp(`\\b${name}\\b`), `${section.id}: a varázsló nem használja: ${name}`)
    }
  }
})

check('lépésenkénti szűrés', () => {
  assert.deepEqual(
    settingSectionsForWizardStep('autonomy').map((section) => section.id),
    ['writeApprovals', 'outputFolder'],
  )
  assert.deepEqual(settingSectionsForWizardStep('start'), [])
})

check('a korábban hiányzó területek mind bekerültek a varázslóba', () => {
  const inWizard = new Set(sections.filter((section) => section.wizardStep).map((section) => section.id))
  for (const id of ['avatar', 'knowledgeBase', 'writeApprovals', 'outputFolder', 'access', 'model', 'hermesPolicy', 'localRoots']) {
    assert.ok(inWizard.has(id), id)
  }
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
