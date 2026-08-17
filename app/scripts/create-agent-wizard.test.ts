/**
 * Új-agent varázsló — lépéskapuk és az új-ablakos kitérők.
 *
 * Futtatás: npx tsx scripts/create-agent-wizard.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  CREATE_AGENT_WIZARD_STEPS,
  assignableConnectorsFromCatalog,
  canEnterCreateAgentWizardStep,
  createAgentWizardContinueHref,
  isIdentityStepComplete,
  isPreCreateComplete,
  isStyleStepComplete,
  nextCreateAgentWizardStep,
  parseCreateAgentWizardStep,
  prevCreateAgentWizardStep,
} from '../src/lib/create-agent-wizard'

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

const emptyGate = {
  name: '',
  roleInstruction: '',
  behaviorProfile: '',
  createdAgentId: null,
}

const filledPre = {
  name: 'Wiki',
  roleInstruction: 'Tudástárból válaszolsz.',
  behaviorProfile: 'Magyarul, tömören.',
  createdAgentId: null,
}

function main() {
  check('a varázsló végigvezeti az összes konfigurációs lépést', () => {
    assert.deepEqual(
      CREATE_AGENT_WIZARD_STEPS.map((s) => s.id),
      [
        'identity',
        'style',
        'model',
        'tools',
        'skills',
        'connections',
        'knowledge',
        'operation',
        'done',
      ],
    )
  })

  check('üres űrlapon csak az Alapok lépés nyitható', () => {
    assert.equal(canEnterCreateAgentWizardStep('identity', emptyGate), true)
    assert.equal(canEnterCreateAgentWizardStep('style', emptyGate), false)
    assert.equal(canEnterCreateAgentWizardStep('model', emptyGate), false)
    assert.equal(canEnterCreateAgentWizardStep('tools', emptyGate), false)
  })

  check('kitöltött alapok után a stílus, majd a modell nyílik', () => {
    assert.equal(isIdentityStepComplete(filledPre), true)
    assert.equal(isStyleStepComplete(filledPre), true)
    assert.equal(isPreCreateComplete(filledPre), true)
    assert.equal(canEnterCreateAgentWizardStep('style', filledPre), true)
    assert.equal(canEnterCreateAgentWizardStep('model', filledPre), true)
    assert.equal(canEnterCreateAgentWizardStep('skills', filledPre), false)
  })

  check('eszköz / skill / kapcsolat csak létrehozott agentnél elérhető', () => {
    const created = { ...filledPre, createdAgentId: 'agent-1' }
    assert.equal(canEnterCreateAgentWizardStep('tools', created), true)
    assert.equal(canEnterCreateAgentWizardStep('skills', created), true)
    assert.equal(canEnterCreateAgentWizardStep('connections', created), true)
    assert.equal(canEnterCreateAgentWizardStep('done', created), true)
  })

  check('next / prev a lépéssorrendet követi', () => {
    assert.equal(nextCreateAgentWizardStep('identity'), 'style')
    assert.equal(nextCreateAgentWizardStep('model'), 'tools')
    assert.equal(nextCreateAgentWizardStep('done'), null)
    assert.equal(prevCreateAgentWizardStep('identity'), null)
    assert.equal(prevCreateAgentWizardStep('tools'), 'model')
  })

  check('ismeretlen step identity-re esik vissza', () => {
    assert.equal(parseCreateAgentWizardStep('nope'), 'identity')
    assert.equal(parseCreateAgentWizardStep('skills'), 'skills')
  })

  check('folytatás URL megőrzi az agentet és a lépést', () => {
    assert.equal(
      createAgentWizardContinueHref('abc', 'connections'),
      '/control-plane/agents/new?continue=abc&step=connections',
    )
  })

  check('hozzárendelhető kapcsolatok: csak http_api/gmail, már kötöttek nélkül', () => {
    const catalog = [
      { id: '1', type: 'http_api', name: 'CRM' },
      { id: '2', type: 'gmail', name: 'Levél' },
      { id: '3', type: 'board', name: 'Board' },
      { id: '4', type: 'http_api', name: 'Már kötve' },
    ]
    const result = assignableConnectorsFromCatalog(catalog, ['4'])
    assert.deepEqual(
      result.map((c) => c.id),
      ['1', '2'],
    )
  })

  check('a kitérők a skill / kapcsolat / profil oldalakra mutatnak', () => {
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills, '/control-plane/skills')
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections, '/control-plane/provisioning')
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors, '/control-plane/connectors')
    assert.equal(
      CREATE_AGENT_WIZARD_EXTERNAL_HREFS.behaviorProfiles,
      '/control-plane/behavior-profiles',
    )
  })

  check('a varázsló és a panelek új ablakban nyitják a kitérőket', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    const skills = readFileSync(
      resolve(process.cwd(), 'src/components/agents/agent-skills-panel.tsx'),
      'utf8',
    )
    const style = readFileSync(
      resolve(process.cwd(), 'src/components/agents/behavior-profile-box.tsx'),
      'utf8',
    )
    const link = readFileSync(
      resolve(process.cwd(), 'src/components/ui/open-in-new-window-link.tsx'),
      'utf8',
    )
    assert.match(link, /target="_blank"/)
    assert.match(link, /rel="noopener noreferrer"/)
    assert.match(wizard, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.skills/)
    assert.match(wizard, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.connections/)
    assert.match(wizard, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.behaviorProfiles/)
    assert.match(skills, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.skills/)
    assert.match(style, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.behaviorProfiles/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
