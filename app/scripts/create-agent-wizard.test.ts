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
  cloneTemplateFromAgent,
  createAgentWizardContinueHref,
  initialEnabledToolNames,
  isIdentityStepComplete,
  isPreCreateComplete,
  matchAssignableConnectorsByName,
  matchAssignableSkillsByName,
  nextCreateAgentWizardStep,
  parseCreateAgentWizardStep,
  prevCreateAgentWizardStep,
  toolSelectionHasChanges,
} from '../src/lib/create-agent-wizard'
import { isAvailableOnMcp } from '../src/lib/agent-lifecycle'

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
  description: '',
  createdAgentId: null,
}

const filledPre = {
  name: 'Wiki',
  roleInstruction: 'Tudástárból válaszolsz.',
  description: 'Belső wiki kérdések.',
  createdAgentId: null,
}

function main() {
  check('a varázsló végigvezeti a megmaradt konfigurációs lépéseket', () => {
    assert.deepEqual(
      CREATE_AGENT_WIZARD_STEPS.map((s) => s.id),
      ['identity', 'tools', 'skills', 'connections', 'done'],
    )
  })

  check('üres űrlapon csak az Alapok lépés nyitható', () => {
    assert.equal(canEnterCreateAgentWizardStep('identity', emptyGate), true)
    assert.equal(canEnterCreateAgentWizardStep('tools', emptyGate), false)
    assert.equal(canEnterCreateAgentWizardStep('done', emptyGate), false)
  })

  check('kitöltött alapok még nem nyitják az eszközöket — előbb létre kell hozni', () => {
    assert.equal(isIdentityStepComplete(filledPre), true)
    assert.equal(isIdentityStepComplete({ ...filledPre, description: '' }), false)
    assert.equal(isPreCreateComplete(filledPre), true)
    assert.equal(canEnterCreateAgentWizardStep('tools', filledPre), false)
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
    assert.equal(nextCreateAgentWizardStep('identity'), 'tools')
    assert.equal(nextCreateAgentWizardStep('tools'), 'skills')
    assert.equal(nextCreateAgentWizardStep('done'), null)
    assert.equal(prevCreateAgentWizardStep('identity'), null)
    assert.equal(prevCreateAgentWizardStep('tools'), 'identity')
  })

  check('ismeretlen step identity-re esik vissza', () => {
    assert.equal(parseCreateAgentWizardStep('nope'), 'identity')
    assert.equal(parseCreateAgentWizardStep('model'), 'identity')
    assert.equal(parseCreateAgentWizardStep('skills'), 'skills')
  })

  check('folytatás URL megőrzi az agentet és a lépést', () => {
    assert.equal(
      createAgentWizardContinueHref('abc', 'connections'),
      '/control-plane/agents/new?continue=abc&step=connections',
    )
  })

  check('hozzárendelhető kapcsolatok: a már kötöttek nélkül', () => {
    const catalog = [
      { id: '1', type: 'http_api', name: 'CRM' },
      { id: '2', type: 'gmail', name: 'Levél' },
      { id: '3', type: 'google_drive', name: 'Drive' },
      { id: '4', type: 'http_api', name: 'Már kötve' },
    ]
    const result = assignableConnectorsFromCatalog(catalog, ['4'])
    assert.deepEqual(
      result.map((c) => c.id),
      ['1', '2', '3'],
    )
  })

  check('a kitérők a skill / kapcsolat oldalakra mutatnak', () => {
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills, '/control-plane/skills')
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections, '/control-plane/provisioning')
    assert.equal(CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors, '/control-plane/account')
  })

  check('skillnév-egyeztetés a javaslatból (kisbetű-érzéketlen)', () => {
    const matched = matchAssignableSkillsByName(
      [
        { name: 'Wiki-QA', activeVersionId: 'v1' },
        { name: 'other', activeVersionId: 'v2' },
      ],
      ['wiki-qa'],
    )
    assert.deepEqual(
      matched.map((s) => s.activeVersionId),
      ['v1'],
    )
  })

  check('kapcsolatnév-egyeztetés a javaslatból (kisbetű-érzéketlen)', () => {
    const matched = matchAssignableConnectorsByName(
      [
        { id: '1', name: 'POSnavigator Presetfilter api' },
        { id: '2', name: 'Meta ads' },
      ],
      ['posnavigator presetfilter api'],
    )
    assert.deepEqual(
      matched.map((c) => c.id),
      ['1'],
    )
  })

  check('Használható az MCP-n csak közzétett aktív agentnél igaz', () => {
    assert.equal(
      isAvailableOnMcp({ status: 'active', currentDefinitionVersionId: 'def-1' }),
      true,
    )
    assert.equal(isAvailableOnMcp({ status: 'active', currentDefinitionVersionId: null }), false)
    assert.equal(
      isAvailableOnMcp({ status: 'draft', currentDefinitionVersionId: 'def-1' }),
      false,
    )
    assert.equal(
      isAvailableOnMcp({ status: 'suspended', currentDefinitionVersionId: 'def-1' }),
      false,
    )
  })

  check('javasolt tool be van jelölve, de még nincs grantolva', () => {
    const enabled = initialEnabledToolNames([], ['kb_search', 'web_search'])
    assert.deepEqual(enabled, ['kb_search', 'web_search'])
    assert.equal(toolSelectionHasChanges(enabled, []), true)
    assert.equal(toolSelectionHasChanges(['kb_search'], ['kb_search']), false)
  })

  check('másolás sablonja a forrás agent granted eszközeit, skilljeit és kapcsolatait viszi', () => {
    const template = cloneTemplateFromAgent({
      sourceAgentId: 'src',
      sourceAgentName: 'Wiki',
      roleInstruction: 'Tudástárból válaszolsz.',
      description: 'Belső wiki kérdések.',
      capabilities: [
        { toolName: 'kb_search', allowed: true },
        { toolName: 'web_search', allowed: false },
      ],
      skills: [{ skillVersionId: 'sv-1' }],
      connectors: [
        { connector: { id: 'c1', name: 'Drive' }, accessMode: 'read' },
      ],
    })
    assert.equal(template.roleInstruction, 'Tudástárból válaszolsz.')
    assert.equal(template.description, 'Belső wiki kérdések.')
    assert.deepEqual(template.enabledTools, ['kb_search'])
    assert.deepEqual(template.skillVersionIds, ['sv-1'])
    assert.deepEqual(template.connectors, [
      { connectorId: 'c1', accessMode: 'read', name: 'Drive' },
    ])
  })

  check('a varázsló támogatja a meglévő agent másolását', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    assert.match(wizard, /cloneTemplateFromAgent/)
    assert.match(wizard, /cloneTitle/)
    assert.match(wizard, /cloneableAgents/)
    assert.match(wizard, /applyCloneSettings/)
  })

  check('a varázsló új-ablakos kitérőket tartalmaz, gondolkodási motor nélkül', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    const publish = readFileSync(
      resolve(process.cwd(), 'src/components/agents/publish-agent-definition-form.tsx'),
      'utf8',
    )
    const skills = readFileSync(
      resolve(process.cwd(), 'src/components/agents/agent-skills-panel.tsx'),
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
    assert.match(wizard, /suggestedTools=\{/)
    assert.match(wizard, /suggestedSkillNames=\{/)
    assert.match(wizard, /suggestedConnectorNames=\{/)
    assert.doesNotMatch(wizard, /draftAgentFromDescription/)
    assert.doesNotMatch(wizard, /ModelTypeSelectField/)
    assert.doesNotMatch(wizard, /providerUsesThinkingProfile/)
    assert.match(wizard, /goLive/)
    assert.match(wizard, /\n\s+wizard\n/)
    assert.match(publish, /mcpSwitchTitle/)
    assert.match(publish, /wizardSaved/)
    assert.match(publish, /suspendAgent/)
    assert.doesNotMatch(publish, /disabled=\{pending \|\| live\}/)
    assert.doesNotMatch(publish, /Published definition/)
    assert.doesNotMatch(publish, />Publish</)
    assert.match(skills, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.skills/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
