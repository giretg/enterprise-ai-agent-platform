/**
 * A rendszeragentek admin-oldalának szerveroldali scope-kapuja.
 *
 * Futtatás: npx tsx scripts/system-agent-registry.test.ts
 */
import assert from 'node:assert/strict'
import {
  isPanelWizardAgent,
  isPanelWizardAgentName,
  selectSystemPanelWizardAgents,
  PLAYBOOK_AUTHOR_AGENT_NAME,
  PROVISIONING_ASSISTANT_AGENT_NAME,
} from '../src/lib/platform-agent-registry'

const tenantId = '00000000-0000-4000-a000-000000000001'

assert.equal(isPanelWizardAgent({ name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId: null }), true)
assert.equal(isPanelWizardAgent({ name: PROVISIONING_ASSISTANT_AGENT_NAME, tenantId: null }), true)
assert.equal(isPanelWizardAgent({ name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId }), false)
assert.equal(isPanelWizardAgent({ name: 'Other global agent', tenantId: null }), false)
assert.equal(isPanelWizardAgentName(PLAYBOOK_AUTHOR_AGENT_NAME), true)
assert.equal(isPanelWizardAgentName(PROVISIONING_ASSISTANT_AGENT_NAME), true)
assert.equal(isPanelWizardAgentName('Other global agent'), false)

const platformWizard = { id: 'platform-wizard', name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId: null }
const tenantLookalike = { id: 'tenant-lookalike', name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId }
const selected = selectSystemPanelWizardAgents([platformWizard, tenantLookalike])
assert.deepEqual(selected.map((agent) => agent.id), ['platform-wizard'])

console.log('A rendszeragent-registry scope-kapu zöld.')
