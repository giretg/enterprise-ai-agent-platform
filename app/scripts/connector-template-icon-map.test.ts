/**
 * Futtatás: node --import tsx scripts/connector-template-icon-map.test.ts
 */
import assert from 'node:assert/strict'
import {
  iconDataUrlByTemplateKey,
  provenanceTemplateKey,
} from '../src/lib/connector-template-icon-map'

const icon = 'data:image/png;base64,platform'
const tenantIcon = 'data:image/png;base64,tenant'

assert.equal(provenanceTemplateKey({ provenance: { templateKey: 'github' } }), 'github')
assert.equal(provenanceTemplateKey({}), null)

const map = iconDataUrlByTemplateKey([
  { key: 'github', tenantId: null, descriptor: { iconDataUrl: icon } },
  { key: 'github', tenantId: 't1', descriptor: { iconDataUrl: tenantIcon } },
])
assert.equal(map.get('github'), tenantIcon)

console.log('connector-template-icon-map.test.ts: ok')
