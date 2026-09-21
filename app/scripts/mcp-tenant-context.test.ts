/**
 * Tenant MCP context helpers.
 * Futtatás: tsx scripts/mcp-tenant-context.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildMcpServerInstructions,
  previewRoleInstruction,
  readTenantMcpIntro,
  tenantDisplayLabel,
  withTenantMcpIntro,
} from '../src/lib/mcp-tenant-context'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('readTenantMcpIntro trims and ignores empty', () => {
  assert.equal(readTenantMcpIntro({ mcpIntro: '  Ostorosbor borászat.  ' }), 'Ostorosbor borászat.')
  assert.equal(readTenantMcpIntro({ mcpIntro: '   ' }), null)
  assert.equal(readTenantMcpIntro({}), null)
})

check('withTenantMcpIntro stores or removes key', () => {
  assert.deepEqual(withTenantMcpIntro({}, 'Hello'), { mcpIntro: 'Hello' })
  assert.deepEqual(withTenantMcpIntro({ language: 'hu' }, 'Hello'), { language: 'hu', mcpIntro: 'Hello' })
  assert.deepEqual(withTenantMcpIntro({ mcpIntro: 'Old' }, ''), {})
})

check('tenantDisplayLabel prefers legalName', () => {
  assert.equal(
    tenantDisplayLabel({ displayName: 'Ostorosbor', legalName: 'Ostorosbor Zrt.', slug: 'ostorosbor' }),
    'Ostorosbor Zrt.',
  )
})

check('previewRoleInstruction truncates long text', () => {
  const long = 'a'.repeat(300)
  const preview = previewRoleInstruction(long, 50)
  assert.ok(preview)
  assert.ok(preview.length <= 50)
  assert.match(preview, /…$/)
})

check('buildMcpServerInstructions includes org intro and coworkers', () => {
  const text = buildMcpServerInstructions({
    tenant: {
      displayName: 'Ostorosbor',
      legalName: 'Ostorosbor Zrt.',
      slug: 'ostorosbor',
      settings: { mcpIntro: 'Magyar borász cég.' },
    },
    tenantSlug: 'ostorosbor',
    coworkers: [
      {
        agentId: 'agent-1',
        name: 'CRM asszisztens',
        status: 'active',
        description: 'Értékesítési adatok.',
        roleInstructionPreview: 'Segít a CRM-ben.',
        currentDefinitionId: 'def-1',
        currentVersion: 1,
      },
    ],
  })
  assert.match(text, /Ostorosbor Zrt\./)
  assert.match(text, /Magyar borász cég\./)
  assert.match(text, /CRM asszisztens/)
  assert.match(text, /agentId agent-1/)
  assert.match(text, /platform\.agents\.list/)
  assert.match(text, /platform\.agent\.checkout/)
  assert.match(text, /LOCAL COWORKER WORKSPACES/)
})

check('buildMcpServerInstructions marks single coworker as default checkout target', () => {
  const text = buildMcpServerInstructions({
    tenant: { displayName: 'Ostorosbor', legalName: null, slug: 'ostorosbor', settings: {} },
    tenantSlug: 'ostorosbor',
    coworkers: [
      {
        agentId: 'reka-id',
        name: 'Réka',
        status: 'active',
        description: 'Borászati asszisztens.',
        roleInstructionPreview: null,
        currentDefinitionId: 'def-10',
        currentVersion: 10,
      },
    ],
  })
  assert.match(text, /Only one coworker is visible/)
  assert.match(text, /Réka \(agentId reka-id/)
  assert.match(text, /default checkout target: Réka \(agentId reka-id\)/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}

console.log('\nAll mcp-tenant-context checks passed.')
