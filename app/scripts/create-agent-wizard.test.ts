/**
 * Új munkatárs felvétele (#957) — lépéskapuk, folytatás, másolás, munkába állítás.
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
  CREATE_AGENT_WIZARD_RESUME_STEP,
  createAgentWizardContinueHref,
  createAgentWizardLastStepStorageKey,
  initialEnabledToolNames,
  isDutiesStepComplete,
  isHalfFinishedAgent,
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
  check('a varázsló a „munkatárs-felvétel” lépéseit követi (#957)', () => {
    assert.deepEqual(
      CREATE_AGENT_WIZARD_STEPS.map((s) => s.id),
      ['start', 'identity', 'duties', 'access', 'knowledge', 'autonomy', 'team', 'advanced', 'launch'],
    )
    assert.deepEqual(
      CREATE_AGENT_WIZARD_STEPS.filter((s) => s.optional).map((s) => s.id),
      ['advanced'],
    )
  })

  check('üres űrlapon az Indulás és a Ki ő? nyitható', () => {
    assert.equal(canEnterCreateAgentWizardStep('start', emptyGate), true)
    assert.equal(canEnterCreateAgentWizardStep('identity', emptyGate), true)
    assert.equal(canEnterCreateAgentWizardStep('duties', emptyGate), false)
    assert.equal(canEnterCreateAgentWizardStep('access', emptyGate), false)
    assert.equal(canEnterCreateAgentWizardStep('launch', emptyGate), false)
  })

  check('kötelező csak a név, a bemutatkozás és egy feladat', () => {
    assert.equal(isIdentityStepComplete(filledPre), true)
    assert.equal(isIdentityStepComplete({ ...filledPre, description: '' }), false)
    assert.equal(isDutiesStepComplete(filledPre), true)
    assert.equal(isDutiesStepComplete({ ...filledPre, roleInstruction: ' ' }), false)
    assert.equal(isPreCreateComplete(filledPre), true)
    assert.equal(isPreCreateComplete({ ...filledPre, roleInstruction: '' }), false)
  })

  check('kitöltött Ki ő? nyitja a Mi a dolga? lépést, de a többit csak a felvétel után', () => {
    assert.equal(canEnterCreateAgentWizardStep('duties', filledPre), true)
    assert.equal(canEnterCreateAgentWizardStep('access', filledPre), false)
    assert.equal(canEnterCreateAgentWizardStep('knowledge', filledPre), false)
  })

  check('felvétel után minden további lépés elérhető, az Indulás már nem', () => {
    const created = { ...filledPre, createdAgentId: 'agent-1' }
    for (const id of ['identity', 'duties', 'access', 'knowledge', 'autonomy', 'team', 'advanced', 'launch'] as const) {
      assert.equal(canEnterCreateAgentWizardStep(id, created), true, id)
    }
    assert.equal(canEnterCreateAgentWizardStep('start', created), false)
  })

  check('next / prev a lépéssorrendet követi', () => {
    assert.equal(nextCreateAgentWizardStep('start'), 'identity')
    assert.equal(nextCreateAgentWizardStep('duties'), 'access')
    assert.equal(nextCreateAgentWizardStep('advanced'), 'launch')
    assert.equal(nextCreateAgentWizardStep('launch'), null)
    assert.equal(prevCreateAgentWizardStep('start'), null)
    assert.equal(prevCreateAgentWizardStep('access'), 'duties')
  })

  check('ismeretlen step az Indulásra (vagy a megadott tartalékra) esik vissza', () => {
    assert.equal(parseCreateAgentWizardStep('nope'), 'start')
    assert.equal(parseCreateAgentWizardStep('tools'), 'start')
    assert.equal(parseCreateAgentWizardStep(null, 'access'), 'access')
    assert.equal(parseCreateAgentWizardStep('knowledge'), 'knowledge')
  })

  check('folytatás URL megőrzi az agentet és a lépést; lépés nélkül a megjegyzettre visz', () => {
    assert.equal(
      createAgentWizardContinueHref('abc', 'team'),
      '/control-plane/agents/new?continue=abc&step=team',
    )
    assert.equal(createAgentWizardContinueHref('abc'), '/control-plane/agents/new?continue=abc')
    assert.equal(CREATE_AGENT_WIZARD_RESUME_STEP, 'access')
    assert.equal(createAgentWizardLastStepStorageKey('abc'), 'agent-hire:last-step:abc')
  })

  check('Félkész = vázlat, amely még soha nem állt munkába', () => {
    assert.equal(isHalfFinishedAgent({ status: 'draft', currentDefinitionVersionId: null }), true)
    assert.equal(isHalfFinishedAgent({ status: 'draft', currentDefinitionVersionId: 'def-1' }), false)
    assert.equal(isHalfFinishedAgent({ status: 'active', currentDefinitionVersionId: 'def-1' }), false)
    assert.equal(isHalfFinishedAgent({ status: 'suspended', currentDefinitionVersionId: null }), false)
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

  check('másolás sablonja: eszközök, skillek, kapcsolatok, önállóság, modell, hozzáférés', () => {
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
      writeModes: { memoryWriteMode: 'direct', httpApiWriteMode: 'approval', gmailWriteMode: 'bogus' },
      approverUserId: 'u-approver',
      modelConfig: { provider: 'openrouter', model: 'x' },
      access: [
        { id: 'u1', name: 'Anna', email: 'a@x', accessLevel: 'operate' },
        { id: 'u2', name: '', email: 'b@x', accessLevel: null },
      ],
    })
    assert.equal(template.roleInstruction, 'Tudástárból válaszolsz.')
    assert.equal(template.description, 'Belső wiki kérdések.')
    assert.deepEqual(template.enabledTools, ['kb_search'])
    assert.deepEqual(template.skillVersionIds, ['sv-1'])
    assert.deepEqual(template.connectors, [
      { connectorId: 'c1', accessMode: 'read', name: 'Drive' },
    ])
    assert.deepEqual(template.writeModes, {
      memory: 'direct',
      httpApi: 'approval',
      gmail: 'approval',
      drive: 'approval',
    })
    assert.equal(template.approverUserId, 'u-approver')
    assert.deepEqual(template.modelConfig, { provider: 'openrouter', model: 'x' })
    assert.deepEqual(template.access, [{ userId: 'u1', accessLevel: 'operate', label: 'Anna' }])
  })

  check('a varázsló támogatja a meglévő agent másolását', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    assert.match(wizard, /cloneTemplateFromAgent/)
    assert.match(wizard, /cloneableAgents/)
    assert.match(wizard, /applyCloneSettings/)
    assert.match(wizard, /listAgentAccess/)
    assert.match(wizard, /updateAgentModelConfig/)
  })

  check('összekötés helyben nyíló ablakban, a régi új-ablakos kitérő a panelekben marad', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    const dialog = readFileSync(
      resolve(process.cwd(), 'src/components/agents/hire/inline-page-dialog.tsx'),
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
    assert.match(wizard, /InlinePageDialog/)
    assert.match(wizard, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\[key\]/)
    assert.match(dialog, /<iframe/)
    assert.match(dialog, /aria-modal="true"/)
    assert.match(skills, /CREATE_AGENT_WIZARD_EXTERNAL_HREFS\.skills/)
  })

  check('munkába állítás = élesítés + aktiválás egy gombbal; a szakértő nézet az adatlap kapcsolóját mutatja', () => {
    const wizard = readFileSync(
      resolve(process.cwd(), 'src/components/agents/create-agent-wizard.tsx'),
      'utf8',
    )
    const launch = readFileSync(
      resolve(process.cwd(), 'src/components/agents/hire/launch-step.tsx'),
      'utf8',
    )
    const publish = readFileSync(
      resolve(process.cwd(), 'src/components/agents/publish-agent-definition-form.tsx'),
      'utf8',
    )
    assert.match(launch, /publishAgentDefinitionAction/)
    assert.match(launch, /activateAgent/)
    assert.match(launch, /resumeAgent/)
    assert.match(launch, /CREATE_AGENT_WIZARD_AFTER_LAUNCH_HREFS\.chat/)
    assert.doesNotMatch(launch, /giveTicket|AFTER_LAUNCH_HREFS\.ticket/)
    assert.match(wizard, /goLive/)
    assert.match(wizard, /\n\s+wizard\n/)
    assert.doesNotMatch(wizard, /draftAgentFromDescription/)
    assert.match(publish, /mcpSwitchTitle/)
    assert.match(publish, /wizardSaved/)
    assert.match(publish, /suspendAgent/)
    assert.doesNotMatch(publish, /disabled=\{pending \|\| live\}/)
    assert.doesNotMatch(publish, />Publish</)
  })

  check('a lista „Félkész” címkéje a varázslóba visz vissza (adminnak)', () => {
    const card = readFileSync(resolve(process.cwd(), 'src/components/agents/agent-catalog-card.tsx'), 'utf8')
    const list = readFileSync(resolve(process.cwd(), 'src/app/control-plane/agents/page.tsx'), 'utf8')
    assert.match(card, /isHalfFinishedAgent/)
    assert.match(card, /createAgentWizardContinueHref\(agent\.id\)/)
    assert.match(card, /halfFinished/)
    assert.match(list, /canResumeHire=\{canCreateAgent\}/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
