/**
 * Agent checkout renderer — published snapshot → file tree, no I/O (#564).
 * Futtatás: npm run test:agent-checkout
 */
import assert from 'node:assert/strict'
import { hashSnapshot, type AgentDefinition } from '../src/domain/agent-definition'
import {
  assertSafeCheckoutPath,
  CHECKOUT_TOOL_DESCRIPTION,
  checkoutSlug,
  hermesBotTitle,
  renderAgentCheckout,
  type CheckoutSkill,
} from '../src/lib/agent-checkout'
import type { SkillContent } from '../src/lib/skill/skill-content'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEFINITION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SKILL_A = '11111111-1111-4111-8111-111111111111'
const SKILL_B = '22222222-2222-4222-8222-222222222222'
const SKILL_C = '33333333-3333-4333-8333-333333333333'
const VER_A = '44444444-4444-4444-8444-444444444444'
const VER_B = '55555555-5555-4555-8555-555555555555'
const VER_LIVE = '66666666-6666-4666-8666-666666666666'
const MCP_URL = 'https://app.example.com/api/mcp/acme'

const pinnedBody: SkillContent = {
  instructions: ['Search only the pinned Drive folders.'],
  triggerKeywords: ['drive', 'search'],
  parameters: [],
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    definitionId: DEFINITION_ID,
    agentId: AGENT_ID,
    version: 3,
    tenantId: '99999999-9999-4999-8999-999999999999',
    status: 'active',
    publishedAt: '2026-01-02T00:00:00.000Z',
    snapshot: {
      name: 'Drive asszisztens',
      roleInstruction: 'Inspect Drive through MCP.',
      skills: [
        { skillId: SKILL_B, skillVersionId: VER_B, name: 'drive-write' },
        { skillId: SKILL_A, skillVersionId: VER_A, name: 'drive-search' },
      ],
      connectors: [{ connectorId: 'c1', type: 'google_drive', accessMode: 'write' }],
      capabilities: [{ toolName: 'google_drive_search', allowed: true }],
    },
    ...overrides,
  }
}

function skill(
  skillId: string,
  skillVersionId: string,
  name: string,
  content: SkillContent = pinnedBody,
): CheckoutSkill {
  return {
    skillId,
    skillVersionId,
    name,
    description: `${name} description`,
    content,
    requires: [],
  }
}

async function main() {
  await check('pin, roleInstruction, mcpUrl, suggestedRoot', () => {
    const def = definition()
    const bundle = renderAgentCheckout({
      definition: def,
      skills: [skill(SKILL_A, VER_A, 'drive-search'), skill(SKILL_B, VER_B, 'drive-write')],
      mcpUrl: MCP_URL,
    })
    assert.equal(bundle.suggestedRoot, 'Agents/drive-asszisztens')
    assert.equal(bundle.mcpUrl, MCP_URL)
    assert.deepEqual(bundle.pin, {
      agentId: AGENT_ID,
      definitionId: DEFINITION_ID,
      version: 3,
      contentHash: hashSnapshot(def.snapshot),
      tenantSlug: 'acme',
      harness: null,
    })
    assert.deepEqual(bundle.deleteUnder, ['.enterprise-agent'])
    const agents = bundle.files.find((file) => file.path === 'AGENTS.md')
    assert.ok(agents)
    assert.match(agents.content, /Inspect Drive through MCP\./)
    assert.match(agents.content, /https:\/\/app\.example\.com\/api\/mcp\/acme/)
    assert.match(agents.content, new RegExp(`contentHash: ${hashSnapshot(def.snapshot)}`))
    assert.deepEqual(
      bundle.files.map((file) => file.path),
      bundle.generatedPaths,
    )
  })

  await check('skill pin vs live: snapshot pins only, missing version warns', () => {
    const live: SkillContent = {
      instructions: ['LIVE body must not appear'],
      triggerKeywords: ['live'],
      parameters: [],
    }
    const bundle = renderAgentCheckout({
      definition: definition(),
      skills: [
        skill(SKILL_A, VER_A, 'drive-search'),
        skill(SKILL_C, VER_LIVE, 'live-only', live),
      ],
      mcpUrl: MCP_URL,
    })
    assert.ok(bundle.warnings.some((row) => row.includes(VER_B)))
    assert.equal(
      bundle.files.some((file) => file.content.includes('LIVE body must not appear')),
      false,
    )
    assert.ok(
      bundle.files.some((file) => file.path === '.enterprise-agent/skills/drive-search/SKILL.md'),
    )
    assert.equal(
      bundle.files.some((file) => file.path.includes('drive-write')),
      false,
    )
    const skillMd = bundle.files.find((file) => file.path.endsWith('drive-search/SKILL.md'))
    assert.ok(skillMd?.content.includes('Search only the pinned Drive folders.'))
  })

  await check('.. and .py paths are rejected', () => {
    assert.throws(() => assertSafeCheckoutPath('../secret.md'))
    assert.throws(() => assertSafeCheckoutPath('.enterprise-agent/skills/x.py'))
    assert.throws(() => assertSafeCheckoutPath('/tmp/AGENTS.md'))
    assertSafeCheckoutPath('AGENTS.md')
    assertSafeCheckoutPath('.enterprise-agent/manifest.json')
  })

  await check('deterministic files[] skillId order; harness stored ignored', () => {
    const skills = [skill(SKILL_B, VER_B, 'drive-write'), skill(SKILL_A, VER_A, 'drive-search')]
    const a = renderAgentCheckout({
      definition: definition(),
      skills,
      mcpUrl: MCP_URL,
      harness: 'codex',
    })
    const b = renderAgentCheckout({
      definition: definition(),
      skills: [...skills].reverse(),
      mcpUrl: MCP_URL,
      harness: 'codex',
    })
    assert.deepEqual(a.files, b.files)
    assert.equal(a.pin.harness, 'codex')
    const skillPaths = a.files.map((file) => file.path).filter((path) => path.includes('/skills/'))
    assert.deepEqual(skillPaths, [
      '.enterprise-agent/skills/drive-search/SKILL.md',
      '.enterprise-agent/skills/drive-write/SKILL.md',
    ])
  })

  await check('empty roleInstruction warns; colliding skill names suffix skillId', () => {
    const def = definition({
      snapshot: {
        ...definition().snapshot,
        roleInstruction: '  ',
        skills: [
          { skillId: SKILL_A, skillVersionId: VER_A, name: 'search' },
          { skillId: SKILL_B, skillVersionId: VER_B, name: 'search' },
        ],
      },
    })
    const bundle = renderAgentCheckout({
      definition: def,
      skills: [skill(SKILL_A, VER_A, 'search'), skill(SKILL_B, VER_B, 'search')],
      mcpUrl: MCP_URL,
    })
    assert.ok(bundle.warnings.includes('empty roleInstruction'))
    assert.ok(bundle.warnings.some((row) => row.includes('collision')))
    const paths = bundle.files.map((file) => file.path)
    assert.ok(paths.includes('.enterprise-agent/skills/search--11111111/SKILL.md'))
    assert.ok(paths.includes('.enterprise-agent/skills/search--22222222/SKILL.md'))
  })

  await check('checkoutSlug empty, max 60, and accented names', () => {
    assert.equal(checkoutSlug('???'), 'agent')
    assert.equal(checkoutSlug('A'.repeat(80)).length, 60)
    assert.equal(checkoutSlug('Réka'), 'reka')
    assert.equal(checkoutSlug('Drive asszisztens'), 'drive-asszisztens')
  })

  await check('AGENTS.md lists http_api connectors when bound', () => {
    const def = definition({
      snapshot: {
        ...definition().snapshot,
        connectors: [
          {
            connectorId: 'c-http',
            name: 'Posnavigator API',
            type: 'http_api',
            accessMode: 'write',
            endpoints: [{ method: 'GET', path: '/api/v1/blogs' }],
          },
        ],
      },
    })
    const bundle = renderAgentCheckout({ definition: def, skills: [], mcpUrl: MCP_URL })
    const agents = bundle.files.find((file) => file.path === 'AGENTS.md')?.content ?? ''
    assert.match(agents, /HTTP API connectors/)
    assert.match(agents, /Posnavigator API/)
    assert.match(agents, /platform\.agent\.get_definition/)
  })

  await check('CHECKOUT_TOOL_DESCRIPTION tells MCP clients not to ask when one agent', () => {
    assert.match(CHECKOUT_TOOL_DESCRIPTION, /exactly one published agent/)
    assert.match(CHECKOUT_TOOL_DESCRIPTION, /do not ask which agent/)
    assert.match(CHECKOUT_TOOL_DESCRIPTION, /first checkout \(create folder\)/)
  })

  await check('codex harness adds Desktop open hint to writeRecipe', () => {
    const bundle = renderAgentCheckout({
      definition: definition(),
      skills: [skill(SKILL_A, VER_A, 'drive-search')],
      mcpUrl: MCP_URL,
      harness: 'codex',
    })
    assert.match(bundle.writeRecipe, /codex app/)
    assert.doesNotMatch(
      renderAgentCheckout({
        definition: definition(),
        skills: [skill(SKILL_A, VER_A, 'drive-search')],
        mcpUrl: MCP_URL,
      }).writeRecipe,
      /codex app/,
    )
    assert.match(bundle.files.find((f) => f.path === 'AGENTS.md')?.content ?? '', /agent_stale/)
  })

  await check('hermes harness → profile distribution (#682 WP-1)', () => {
    const def = definition()
    const bundle = renderAgentCheckout({
      definition: def,
      skills: [skill(SKILL_A, VER_A, 'Napi Marketing Riport'), skill(SKILL_B, VER_B, 'drive-write')],
      mcpUrl: MCP_URL,
      harness: 'hermes',
    })
    // Pins decide the skill label; give the snapshot a non-slug name too.
    const napi = renderAgentCheckout({
      definition: definition({
        snapshot: {
          ...def.snapshot,
          skills: [{ skillId: SKILL_A, skillVersionId: VER_A, name: 'Napi Marketing Riport' }],
        },
      }),
      skills: [skill(SKILL_A, VER_A, 'Napi Marketing Riport')],
      mcpUrl: MCP_URL,
      harness: 'hermes',
    })
    const napiSkill = napi.files.find((f) => f.path.startsWith('skills/excellence/'))
    assert.equal(napiSkill?.path, 'skills/excellence/napi-marketing-riport/SKILL.md')
    assert.match(napiSkill?.content ?? '', /^---\nname: napi-marketing-riport\ntitle: Napi Marketing Riport\n/)

    assert.equal(bundle.suggestedRoot, '.hermes/excellence/acme/drive-asszisztens')
    assert.deepEqual(bundle.files.map((f) => f.path), bundle.generatedPaths)
    for (const path of bundle.generatedPaths) assertSafeCheckoutPath(path)
    assert.ok(bundle.generatedPaths.includes('SOUL.md'))
    assert.ok(!bundle.generatedPaths.includes('AGENTS.md'))
    for (const file of bundle.files.filter((f) => f.path.startsWith('skills/excellence/'))) {
      const name = /^name: (.+)$/m.exec(file.content)?.[1] ?? ''
      assert.match(name, /^[a-z0-9][a-z0-9._-]*$/)
      assert.equal(file.path, `skills/excellence/${name}/SKILL.md`)
    }

    const content = (path: string) => bundle.files.find((f) => f.path === path)?.content ?? ''
    const config = content('config.yaml')
    assert.match(config, /memory_enabled: false/)
    assert.match(config, /user_profile_enabled: false/)
    assert.match(config, new RegExp(`X-Excellence-Agent-Id: ${AGENT_ID}`))
    assert.match(config, /auth: oauth/)
    assert.match(config, /- google_drive_search/)
    assert.match(config, /- platform\.agent\.get_definition/)
    assert.doesNotMatch(config, /platform\.agent\.publish|platform\.agent\.create_draft/)

    const dist = content('distribution.yaml')
    assert.match(dist, /name: exc-drive-asszisztens/)
    assert.match(dist, /version: 3\.0\.0/)
    const owned = dist.slice(dist.indexOf('distribution_owned'))
    assert.doesNotMatch(owned, /config\.yaml|profile\.yaml/)
    const profileYaml = content('profile.yaml')
    assert.match(profileYaml, /display_name: Drive asszisztens \(Inspect Drive through MCP\)/)
    assert.match(profileYaml, /title: Drive asszisztens \(Inspect Drive through MCP\)/)

    const soul = content('SOUL.md')
    assert.match(soul, /do not pass definitionId/)
    assert.match(soul, new RegExp(`contentHash: ${hashSnapshot(def.snapshot)}`))
    assert.doesNotMatch(soul, /agent_stale/)
    assert.match(bundle.writeRecipe, /hermes profile install "\$HOME\/\.hermes\/excellence\/acme\/drive-asszisztens" --name exc-drive-asszisztens -y/)
    assert.match(bundle.writeRecipe, /hermes profile update exc-drive-asszisztens -y/)
    assert.match(bundle.writeRecipe, /display_name and ui_meta\.hermes-bots\.title/)
    assert.doesNotMatch(bundle.writeRecipe, /hermes profile delete exc/)
    assert.equal(JSON.parse(content('.enterprise-agent/manifest.json')).pin.harness, 'hermes')
  })

  await check('hermes Bot title is name (role), not the exc- profile id', () => {
    assert.equal(
      hermesBotTitle({ name: 'Zoli', roleInstruction: 'POSnavigator marketing lead.\nHosszú utasítás.' }),
      'Zoli (POSnavigator marketing lead)',
    )
    assert.equal(
      hermesBotTitle({
        name: 'Ági',
        description: 'POS marketing',
        roleInstruction: 'Egy egész oldalnyi szerep-utasítás, amit a címkébe nem írunk.',
      }),
      'Ági (POS marketing)',
    )
    assert.equal(hermesBotTitle({ name: 'Drive asszisztens', roleInstruction: 'Drive asszisztens' }), 'Drive asszisztens')
    const titled = hermesBotTitle({ name: 'Kati', roleInstruction: 'A'.repeat(80) })
    assert.match(titled, /^Kati \(.+…\)$/)
    assert.ok(titled.length <= 56)
  })

  if (failures > 0) {
    console.error(`${failures} failed`)
    process.exit(1)
  }
  console.log('agent-checkout: ok')
}

void main()
