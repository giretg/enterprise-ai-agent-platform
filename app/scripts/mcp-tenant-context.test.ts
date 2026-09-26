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
  assert.match(text, /LOCAL AGENT WORKSPACES/)
  assert.ok(text.indexOf("MEMORY FIRST") < text.indexOf("YOUR ROLE"), "memory rule precedes role")
  assert.match(text, /generalMemory/)
  assert.match(text, /platform\.agent\.get_definition/)
  assert.match(text, /no separate in-platform/)
  assert.match(text, /tools\/list as the callable tool list/)
  assert.match(text, /http_api_get_all only when the endpoint has pagination/)
  assert.match(text, /gmail_send/)
  assert.match(text, /never answer that email sending is unavailable/)
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
  assert.match(text, /Only one agent is visible/)
  assert.match(text, /Réka \(agentId reka-id/)
  assert.match(text, /Call when: Borászati asszisztens\./)
  assert.match(text, /Default checkout target: Réka/)
  assert.match(text, /stay in that role/)
  assert.doesNotMatch(text, /CHOOSE AND STAY/)
})

const POS_COWORKERS = [
  {
    agentId: 'kati-id',
    name: 'Kati',
    status: 'active',
    description:
      'Marketing, SEO, tartalom, blog, hirdetésszöveg, napi marketing riport. Nem sales lead, nem számla.',
    roleInstructionPreview: 'Hosszú marketing szerep-utasítás, amit a választáshoz nem használunk.',
    currentDefinitionId: 'def-kati',
    currentVersion: 1,
  },
  {
    agentId: 'gabor-id',
    name: 'Gábor',
    status: 'active',
    description: 'Sales, CRM, lead, árajánlat, pipeline. Nem marketing tartalom, nem számla, nem könyvelés.',
    roleInstructionPreview: null,
    currentDefinitionId: 'def-gabor',
    currentVersion: 1,
  },
  {
    agentId: 'mark-id',
    name: 'Márk',
    status: 'active',
    description: 'Pénzügy, számla, könyvelés, bér. Nem sales, nem marketing.',
    roleInstructionPreview: null,
    currentDefinitionId: 'def-mark',
    currentVersion: 1,
  },
]

check('buildMcpServerInstructions with several agents: choose, stay, handoff, Call when', () => {
  const text = buildMcpServerInstructions({
    tenant: { displayName: 'POSnavigator', legalName: null, slug: 'posnavigator', settings: {} },
    tenantSlug: 'posnavigator',
    coworkers: POS_COWORKERS,
  })
  assert.match(text, /CHOOSE AND STAY/)
  assert.match(text, /Do not ask which agent/)
  assert.match(text, /do not switch silently/)
  assert.match(text, /slash prompt/)
  assert.match(text, /Kati, the marketing teammate/)
  assert.match(text, /Call when: Marketing, SEO, tartalom/)
  assert.match(text, /Call when: Sales, CRM, lead/)
  assert.match(text, /Call when: Pénzügy, számla/)
  assert.doesNotMatch(text, /Hosszú marketing szerep-utasítás/)
})

const STOP = new Set(['and', 'the', 'for', 'nem', 'egy'])

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !STOP.has(token))
}

/** Positive clause only — "Nem sales" is a boundary for the model, not a sales keyword. */
function pickCoworkerByScope(request: string, coworkers: typeof POS_COWORKERS): string {
  const query = tokens(request)
  let bestName = coworkers[0]!.name
  let best = -1
  for (const coworker of coworkers) {
    const positive = coworker.description.split(/\b(?:[Nn]em|[Nn]ot)\b/)[0] ?? coworker.description
    const hay = new Set(tokens(`${coworker.name} ${positive}`))
    const score = query.reduce((n, token) => n + (hay.has(token) ? 1 : 0), 0)
    if (score > best) {
      best = score
      bestName = coworker.name
    }
  }
  return bestName
}

check('eval: 10 typical requests, 3 agents, at least 9/10 pick the matching teammate', () => {
  const cases: Array<[string, string]> = [
    ['Írj SEO blogot a POS-ról', 'Kati'],
    ['Napi marketing riport', 'Kati'],
    ['Új sales lead a CRM-be', 'Gábor'],
    ['Árajánlat egy érdeklődőnek', 'Gábor'],
    ['Kiállított számla a megrendelésről', 'Márk'],
    ['Könyvelés egyeztetés', 'Márk'],
    ['Hirdetésszöveg a kampányhoz', 'Kati'],
    ['Pipeline státusz a hétre', 'Gábor'],
    ['Tartalom és blog a hónapra', 'Kati'],
    ['Havi bér lista', 'Márk'],
  ]
  const hits = cases.filter(([request, expected]) => pickCoworkerByScope(request, POS_COWORKERS) === expected)
  assert.ok(hits.length >= 9, `expected ≥9/10, got ${hits.length}/10`)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}

console.log('\nAll mcp-tenant-context checks passed.')
