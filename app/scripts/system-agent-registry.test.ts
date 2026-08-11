/**
 * A rendszeragentek admin-oldalának szerveroldali scope-kapuja.
 *
 * Futtatás: npx tsx scripts/system-agent-registry.test.ts
 */
import assert from 'node:assert/strict'
import {
  isPanelWizardAgent,
  PLAYBOOK_AUTHOR_AGENT_NAME,
  PROVISIONING_ASSISTANT_AGENT_NAME,
} from '../src/lib/platform-agent-registry'

const tenantId = '00000000-0000-4000-a000-000000000001'

assert.equal(isPanelWizardAgent({ name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId: null }), true)
assert.equal(isPanelWizardAgent({ name: PROVISIONING_ASSISTANT_AGENT_NAME, tenantId: null }), true)
assert.equal(isPanelWizardAgent({ name: PLAYBOOK_AUTHOR_AGENT_NAME, tenantId }), false)
assert.equal(isPanelWizardAgent({ name: 'Other global agent', tenantId: null }), false)

console.log('A rendszeragent-registry scope-kapu zöld.')
