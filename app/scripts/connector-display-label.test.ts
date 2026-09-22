import assert from 'node:assert/strict'
import {
  AGENT_OWNED_KB_CONNECTOR_DISPLAY_LABEL,
  connectorDisplayLabel,
} from '../src/lib/connector-display-label'
import { isAgentDetailSectionId } from '../src/lib/agent-detail-sections'

assert.equal(
  connectorDisplayLabel('knowledge_base', 'kb:266a865e-0663-425c-a80f-6b5b7498d28b'),
  AGENT_OWNED_KB_CONNECTOR_DISPLAY_LABEL,
)
assert.equal(connectorDisplayLabel('http_api', 'Posnavigator – banks'), 'Posnavigator – banks')
assert.equal(connectorDisplayLabel('knowledge_base', 'kb:catalog'), 'kb:catalog')
assert.equal(isAgentDetailSectionId('kapcsolatok'), true)
assert.equal(isAgentDetailSectionId('nincs'), false)

console.log('OK connector-display-label')
