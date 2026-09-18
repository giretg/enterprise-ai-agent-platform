/**
 * Agent Definition publish/load — in-memory deps, no live DB (#539).
 * Futtatás: npm run test:agent-definition
 */
import assert from 'node:assert/strict'
import type { Agent, AgentDefinitionVersion, AgentSkill, Prisma, Skill, SkillVersion } from '@prisma/client'
import {
  AgentDefinitionService,
  hashSnapshot,
  type AgentDefinitionSnapshot,
} from '../src/domain/agent-definition'
import type { AgentConnectorBinding, AgentSkillWithVersion } from '../src/repositories/interfaces'

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

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'
const SKILL_ID = '55555555-5555-4555-8555-555555555555'
const SKILL_VERSION_ID = '66666666-6666-4666-8666-666666666666'
const CONNECTOR_ID = '77777777-7777-4777-8777-777777777777'

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    tenantId: TENANT_A,
    name: 'Drive assistant',
    roleInstruction: 'Inspect Drive through MCP.',
    status: 'draft',
    currentDefinitionVersionId: null,
    avatarUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    retiredAt: null,
    ...overrides,
  }
}

function memoryDeps() {
  const agents = new Map<string, Agent>([[AGENT_ID, agentRow()]])
  const versions: AgentDefinitionVersion[] = []
  return {
    agents,
    versions,
    service: new AgentDefinitionService({
      agents: {
        async findById(id, tenantId) {
          const row = agents.get(id) ?? null
          if (!row) return null
          if (tenantId && row.tenantId !== tenantId) return null
          return row
        },
        async setCurrentDefinitionVersionId(agentId, versionId) {
          const row = agents.get(agentId)
          if (!row) throw new Error('missing')
          const next = { ...row, currentDefinitionVersionId: versionId }
          agents.set(agentId, next)
          return next
        },
        async findCapabilitiesForAgent() {
          return [
            { toolName: 'google_drive_search', allowed: true },
            { toolName: 'google_drive_read_file', allowed: true },
          ]
        },
        async findConnectorsForAgent(): Promise<AgentConnectorBinding[]> {
          return [
            {
              accessMode: 'read',
              connector: {
                id: CONNECTOR_ID,
                type: 'google_drive',
                name: 'Google Drive',
                authMode: 'user_delegated',
                scope: 'single',
                secretAlias: 'secret://google-drive/oauth-client',
                version: 1,
                config: {},
                lifecycleState: 'active',
                tenantId: TENANT_A,
                createdAt: new Date(),
              },
            },
          ]
        },
      },
      versions: {
        async create(data) {
          const row: AgentDefinitionVersion = {
            id: `def-${data.version}`,
            agentId: data.agentId,
            version: data.version,
            snapshot: data.snapshot as Prisma.JsonValue,
            contentHash: data.contentHash,
            publishedById: data.publishedById,
            publishedAt: new Date('2026-01-02T00:00:00Z'),
          }
          versions.push(row)
          return row
        },
        async findById(id) {
          return versions.find((row) => row.id === id) ?? null
        },
        async findByAgentAndVersion(agentId, version) {
          return versions.find((row) => row.agentId === agentId && row.version === version) ?? null
        },
        async findMaxVersion(agentId) {
          return versions.filter((row) => row.agentId === agentId).reduce((max, row) => Math.max(max, row.version), 0)
        },
      },
      skills: {
        async listEnabledForAgent(): Promise<AgentSkillWithVersion[]> {
          const skill: Skill = {
            id: SKILL_ID,
            name: 'drive-review',
            displayName: 'Drive review',
            description: 'Review Drive files',
            catalogScope: 'tenant',
            tenantId: TENANT_A,
            kind: 'tenant',
            sourceType: 'authored',
            provenance: null,
            license: null,
            riskTier: 't0',
            createdAt: new Date(),
          }
          const skillVersion: SkillVersion = {
            id: SKILL_VERSION_ID,
            skillId: SKILL_ID,
            version: 1,
            content: {},
            requires: [],
            attachments: null,
            status: 'active',
            contentHash: 'abc',
            approvedById: USER_ID,
            createdAt: new Date(),
          }
          const assignment: AgentSkill = {
            agentId: AGENT_ID,
            skillVersionId: SKILL_VERSION_ID,
            enabled: true,
            assignedById: USER_ID,
            createdAt: new Date(),
          }
          return [{ ...assignment, skillVersion: { ...skillVersion, skill } }]
        },
      },
    }),
  }
}

async function main() {
  await check('publish snapshot has skills/connectors/capabilities and no secrets', async () => {
    const { service, versions } = memoryDeps()
    const published = await service.publishAgentDefinition({
      agentId: AGENT_ID,
      tenantId: TENANT_A,
      publishedById: USER_ID,
    })
    assert.equal(published.version, 1)
    assert.equal(published.definitionId, versions[0].id)
    assert.equal(published.snapshot.name, 'Drive assistant')
    assert.equal(published.snapshot.skills[0]?.skillId, SKILL_ID)
    assert.equal(published.snapshot.connectors[0]?.connectorId, CONNECTOR_ID)
    assert.deepEqual(
      published.snapshot.capabilities.map((row) => row.toolName).sort(),
      ['google_drive_read_file', 'google_drive_search'],
    )
    const json = JSON.stringify(published.snapshot)
    assert.equal(json.includes('tokenRef'), false)
    assert.equal(json.includes('secretAlias'), false)
    assert.equal(json.includes('modelConfig'), false)
    assert.equal(json.includes(USER_ID), false)
  })

  await check('second publish does not mutate v1 bytes', async () => {
    const { service, versions, agents } = memoryDeps()
    const v1 = await service.publishAgentDefinition({
      agentId: AGENT_ID,
      tenantId: TENANT_A,
      publishedById: USER_ID,
    })
    const v1Bytes = JSON.stringify(versions[0].snapshot)
    const current = agents.get(AGENT_ID)!
    agents.set(AGENT_ID, { ...current, roleInstruction: 'Changed after publish.' })
    const v2 = await service.publishAgentDefinition({
      agentId: AGENT_ID,
      tenantId: TENANT_A,
      publishedById: USER_ID,
    })
    assert.equal(v2.version, 2)
    assert.equal(JSON.stringify(versions[0].snapshot), v1Bytes)
    assert.equal(v1.snapshot.roleInstruction, 'Inspect Drive through MCP.')
    assert.equal(v2.snapshot.roleInstruction, 'Changed after publish.')
  })

  await check('load by definitionId and current by agentId', async () => {
    const { service } = memoryDeps()
    const published = await service.publishAgentDefinition({
      agentId: AGENT_ID,
      tenantId: TENANT_A,
      publishedById: USER_ID,
    })
    const byId = await service.loadAgentDefinition({
      tenantId: TENANT_A,
      definitionId: published.definitionId,
    })
    const current = await service.loadAgentDefinition({ tenantId: TENANT_A, agentId: AGENT_ID })
    assert.equal(byId?.definitionId, published.definitionId)
    assert.equal(current?.definitionId, published.definitionId)
  })

  await check('wrong tenantId returns null', async () => {
    const { service } = memoryDeps()
    const published = await service.publishAgentDefinition({
      agentId: AGENT_ID,
      tenantId: TENANT_A,
      publishedById: USER_ID,
    })
    const leaked = await service.loadAgentDefinition({
      tenantId: TENANT_B,
      definitionId: published.definitionId,
    })
    assert.equal(leaked, null)
  })

  await check('contentHash is sha256 of canonical JSON', () => {
    const snapshot: AgentDefinitionSnapshot = {
      name: 'A',
      roleInstruction: 'B',
      skills: [],
      connectors: [],
      capabilities: [{ toolName: 'google_drive_search', allowed: true }],
    }
    assert.match(hashSnapshot(snapshot), /^[a-f0-9]{64}$/)
  })

  if (failures > 0) {
    console.error(`agent-definition: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('agent-definition: ok')
}

void main()
