import assert from 'node:assert/strict'
import { findHttpApiEndpoint, parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import {
  AGENTMAIL_TEMPLATE_KEY,
  BUILTIN_CONNECTOR_TEMPLATES,
} from '../src/domain/connector-template/builtin-templates'
import { materializeConnectorConfig } from '../src/domain/connector-template/materializer'
import { parseTemplateDescriptor } from '../src/domain/connector-template/template-descriptor'
import { normalizeConnectorConfig } from '../src/domain/provisioning/connector-config'
import { agentMailInboxPathSegment, inboxIdFromConnectorBaseUrl } from '../src/lib/agentmail'

const descriptor = parseTemplateDescriptor(
  BUILTIN_CONNECTOR_TEMPLATES.find((t) => t.key === AGENTMAIL_TEMPLATE_KEY),
)
const inboxId = 'anna@agentmail.to'
const config = normalizeConnectorConfig({
  ...materializeConnectorConfig(
    descriptor,
    { authMethodKind: 'bearer', instanceValues: { inboxId: agentMailInboxPathSegment(inboxId) } },
    {},
  ),
  description: 'A munkatárs SAJÁT postafiókja',
})

assert.equal(config.baseUrl, 'https://api.agentmail.eu/v0/inboxes/anna%40agentmail.to')
assert.equal(config.provider, AGENTMAIL_TEMPLATE_KEY)
assert.equal(config.restrictToEndpoints, true)
assert.equal(config.description, 'A munkatárs SAJÁT postafiókja')
assert.equal(inboxIdFromConnectorBaseUrl(config.baseUrl), inboxId)
assert.equal(inboxIdFromConnectorBaseUrl('https://api.agentmail.eu/v0/inboxes/a/b'), null)

const runtime = parseHttpApiConfig(config)
assert.ok(findHttpApiEndpoint(runtime, 'POST', '/messages/send'))
assert.ok(findHttpApiEndpoint(runtime, 'POST', '/messages/<m1@x>/reply'))
assert.equal(findHttpApiEndpoint(runtime, 'POST', '/../other@agentmail.to/messages/send'), undefined)
assert.equal(findHttpApiEndpoint(runtime, 'DELETE', '/messages/m1'), undefined)
assert.equal(findHttpApiEndpoint(runtime, 'POST', '/api-keys'), undefined)

console.log('agentmail connector: ok')
