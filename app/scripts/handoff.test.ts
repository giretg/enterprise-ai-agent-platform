/**
 * MCP handoff (#664): agent→agent open_task + briefing, human inbox, ack.
 * Futtatás: npm run test:handoff
 */
import assert from 'node:assert/strict'
import type { ProjectMemoryKind, ProjectMemoryRecord, ProjectMemoryStore } from '../src/domain/project-work/types'
import { invokeProjectWork } from '../src/domain/project-work/mcp'
import { ProjectWorkService } from '../src/domain/project-work/project-work-service'
import { validateHandoffInput, formatHandoffMemoryBody, parseHandoffLinks } from '../src/domain/handoff/handoff-service'
import { renderAgentBriefing } from '../src/lib/agent-checkout'
import type { AgentDefinition } from '../src/domain/agent-definition'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const KATI = '22222222-2222-4222-8222-222222222222'
const GABOR = '33333333-3333-4333-8333-333333333333'
const KATI_DEF = '44444444-4444-4444-8444-444444444444'
const GABOR_DEF = '55555555-5555-4555-8555-555555555555'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ZOLI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

class MemMemory implements ProjectMemoryStore {
  rows = new Map<string, ProjectMemoryRecord>()
  async listActive(input: { tenantId: string; agentId: string; projectKey: string; withUserId?: string }) {
    return [...this.rows.values()].filter(
      (row) =>
        row.tenantId === input.tenantId &&
        row.agentId === input.agentId &&
        row.projectKey === input.projectKey &&
        row.status === 'active' &&
        (input.withUserId ? row.withUserId === input.withUserId : true),
    )
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null
  }
  async insertActive(input: {
    tenantId: string
    agentId: string
    projectKey: string
    kind: ProjectMemoryKind
    title: string
    body: string
    artifactPath: string | null
    withUserId: string
    supersedesId: string | null
    alsoSupersedeIds: string[]
  }) {
    const row: ProjectMemoryRecord = {
      id: globalThis.crypto.randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      projectKey: input.projectKey,
      kind: input.kind,
      title: input.title,
      body: input.body,
      artifactPath: input.artifactPath,
      withUserId: input.withUserId,
      status: 'active',
      supersedesId: input.supersedesId,
      createdAt: new Date(),
    }
    this.rows.set(row.id, row)
    return row
  }
}

type HandoffRow = {
  id: string
  tenantId: string
  fromAgentId: string
  toAgentId: string | null
  toUserId: string | null
  status: string
}

class MemHandoffs {
  rows = new Map<string, HandoffRow & { projectKey: string; title: string; summary: string; links: string | null; memoryId: string | null; createdById: string; decidedById: string | null; idempotencyKey: string | null }>()
  async insert(input: {
    tenantId: string
    fromAgentId: string
    fromDefinitionId: string
    toAgentId: string | null
    toUserId: string | null
    projectKey: string
    title: string
    summary: string
    links: string | null
    createdById: string
    idempotencyKey?: string | null
  }) {
    const idempotencyKey = input.idempotencyKey ?? null
    if (idempotencyKey) {
      // #940: ugyanaz a (tenant, küldő agent, kulcs) → a meglévő sort adjuk vissza.
      for (const existing of this.rows.values()) {
        if (existing.tenantId === input.tenantId && existing.fromAgentId === input.fromAgentId && existing.idempotencyKey === idempotencyKey) {
          return { handoff: existing, created: false }
        }
      }
    }
    const row = { id: globalThis.crypto.randomUUID(), status: 'open', memoryId: null as string | null, decidedById: null as string | null, ...input, idempotencyKey }
    this.rows.set(row.id, row)
    return { handoff: row, created: true }
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null
  }
  async attachMemory(id: string, memoryId: string) {
    const row = this.rows.get(id)
    if (row) row.memoryId = memoryId
  }
  async decide(id: string, status: 'accepted' | 'done' | 'rejected', decidedById: string) {
    const row = this.rows.get(id)
    if (!row || row.status === 'done' || row.status === 'rejected') return null
    row.status = status
    row.decidedById = decidedById
    return row
  }
}

const katiDef: AgentDefinition = {
  definitionId: KATI_DEF,
  agentId: KATI,
  version: 1,
  tenantId: TENANT,
  status: 'active',
  publishedAt: '2026-01-01T00:00:00.000Z',
  snapshot: { name: 'Kati', roleInstruction: 'Sales.', skills: [], connectors: [], capabilities: [] },
}

const gaborDef: AgentDefinition = {
  definitionId: GABOR_DEF,
  agentId: GABOR,
  version: 1,
  tenantId: TENANT,
  status: 'active',
  publishedAt: '2026-01-01T00:00:00.000Z',
  snapshot: { name: 'Gábor', roleInstruction: 'Tech.', skills: [], connectors: [], capabilities: [] },
}

function deps(overrides: Record<string, unknown> = {}) {
  const memory = new MemMemory()
  const handoffs = new MemHandoffs()
  const svc = new ProjectWorkService(
    { listByTenant: async () => [], findByKey: async () => null, create: async () => { throw new Error('no') } },
    { list: async () => [], find: async () => null, upsert: async () => { throw new Error('no') }, delete: async () => false, quota: async () => ({ count: 0, bytes: 0 }) },
    memory,
    { findMemoryWriteMode: async () => 'approval', updateMemoryWriteMode: async () => {} },
    { findManyByIds: async (ids: string[]) => ids.map((id) => ({ id, name: id })) },
  )
  return {
    memory,
    handoffs,
    invokeArgs: {
      loadDefinition: async () => katiDef,
      loadDefinitionByAgent: async (input: { agentId: string }) => (input.agentId === GABOR ? gaborDef : null),
      findCurrentDefinitionId: async () => KATI_DEF,
      findAgentGrant: async () => ({ accessLevel: 'operate' }),
      canViewAgent: async () => true,
      isTenantMember: async () => true,
      projectWork: svc,
      handoffs,
      ...overrides,
    } as Parameters<typeof invokeProjectWork>[0],
  }
}

function parsePayload(result: { content: Array<{ text: string }>; isError?: true }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

async function main() {
  await check('validation: exactly one target', () => {
    assert.equal(validateHandoffInput({ title: 'T', summary: 'S' }).ok, false)
    assert.equal(validateHandoffInput({ toAgentId: GABOR, toUserId: ZOLI, title: 'T', summary: 'S' }).ok, false)
    assert.equal(validateHandoffInput({ toAgentId: GABOR, title: 'T', summary: 'S' }).ok, true)
  })

  await check('Kati → Gábor: open_task bypasses approval mode and links the handoff', async () => {
    const { memory, handoffs, invokeArgs } = deps()
    const out = parsePayload(
      await invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: {
          definitionId: KATI_DEF,
          toAgentId: GABOR,
          title: 'Sales lead: Acme',
          summary: 'Keresés: árajánlat 3 napon belül.',
          links: 'Ajánlat | work_file:/plans/acme.md',
          idempotencyKey: 'h1',
        },
      }),
    )
    assert.equal(out.ok, true)
    const handoffId = out.handoffId as string
    assert.ok(handoffId)
    const row = await handoffs.findById(handoffId)
    assert.equal(row?.status, 'open')
    assert.ok(row?.memoryId)
    const memRows = await memory.listActive({ tenantId: TENANT, agentId: GABOR, projectKey: '__general__' })
    assert.equal(memRows.length, 1)
    assert.equal(memRows[0]?.kind, 'open_task')
    assert.ok(memRows[0]?.body.includes(handoffId))
    assert.ok(memRows[0]?.body.includes('Kati'))
    assert.equal(out.notified, 'agent_memory')
  })

  // #940 regression: egy retry (azonos idempotencyKey) nem hozhat létre második
  // átadást, és nem injektálhat második open_task-ot a címzett memóriájába. A régi
  // kód a kulcsot figyelmen kívül hagyta → duplikált átadás + duplikált memória.
  await check('idempotencyKey: ismételt hívás nem duplikál átadást/memóriát', async () => {
    const { memory, handoffs, invokeArgs } = deps()
    const args = {
      principal: { userId: ANNA, tenantId: TENANT, role: 'operator' as const, assumed: false },
      toolName: 'platform.handoff',
      args: {
        definitionId: KATI_DEF,
        toAgentId: GABOR,
        title: 'Sales lead: Acme',
        summary: 'Keresés: árajánlat 3 napon belül.',
        idempotencyKey: 'retry-key',
      },
    }
    const first = parsePayload(await invokeProjectWork(invokeArgs, args))
    const second = parsePayload(await invokeProjectWork(invokeArgs, args))
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    // Ugyanaz az átadás jön vissza, a második idempotensként jelölve.
    assert.equal(second.handoffId, first.handoffId)
    assert.equal(second.idempotent, true)
    // Csak egy átadás-sor és csak egy open_task a címzett memóriájában.
    assert.equal(handoffs.rows.size, 1)
    const memRows = await memory.listActive({ tenantId: TENANT, agentId: GABOR, projectKey: '__general__' })
    assert.equal(memRows.length, 1)
  })

  await check('idempotencyKey: más tartalommal újrahasznált kulcs ütközést ad, nem nyeli el', async () => {
    const { handoffs, invokeArgs } = deps()
    const base = {
      principal: { userId: ANNA, tenantId: TENANT, role: 'operator' as const, assumed: false },
      toolName: 'platform.handoff',
    }
    const first = parsePayload(await invokeProjectWork(invokeArgs, {
      ...base,
      args: { definitionId: KATI_DEF, toAgentId: GABOR, title: 'Első feladat', summary: 'A', idempotencyKey: 'handoff-1' },
    }))
    const reused = await invokeProjectWork(invokeArgs, {
      ...base,
      args: { definitionId: KATI_DEF, toAgentId: GABOR, title: 'Második feladat', summary: 'B', idempotencyKey: 'handoff-1' },
    })
    assert.equal(first.ok, true)
    assert.equal(reused.isError, true)
    assert.match(JSON.stringify(reused), /idempotency_key_conflict/)
    assert.equal(handoffs.rows.size, 1)
  })

  // Security regression: a caller with only `view` on the recipient agent must NOT
  // be able to force an open_task into that agent's trusted memory (memory poisoning
  // / privilege escalation — a direct memory write would require `operate`). The
  // handoff is still delivered via the recipient's briefing (the Handoff row).
  await check('view-only recipient: handoff delivered but memory NOT injected', async () => {
    const { memory, handoffs, invokeArgs } = deps({
      // operate on the sender (Kati), only view on the recipient (Gábor)
      findAgentGrant: async (input: { agentId: string }) =>
        input.agentId === GABOR ? { accessLevel: 'view' } : { accessLevel: 'operate' },
    })
    const out = parsePayload(
      await invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: { definitionId: KATI_DEF, toAgentId: GABOR, title: 'Átadás', summary: 'Nézd meg.', idempotencyKey: 'hv1' },
      }),
    )
    assert.equal(out.ok, true)
    const row = await handoffs.findById(out.handoffId as string)
    assert.equal(row?.status, 'open') // handoff still delivered (briefing/inbox)
    assert.equal(row?.memoryId, null) // but no memory injected
    assert.equal(out.memoryId, null)
    assert.equal(out.notified, 'inbox')
    const memRows = await memory.listActive({ tenantId: TENANT, agentId: GABOR, projectKey: '__general__' })
    assert.equal(memRows.length, 0) // recipient memory not poisoned
  })

  await check('briefing shows handed-off work with handoffId', () => {
    const briefing = renderAgentBriefing({
      definition: gaborDef,
      skills: [],
      handoffs: [{ id: 'handoff-1', title: 'Sales lead: Acme', projectKey: '__general__', createdAt: '2026-09-27T00:00:00.000Z', fromAgentName: 'Kati' }],
    })
    assert.ok(briefing.includes('## Handed-off work'))
    assert.ok(briefing.includes('handoff-1'))
    assert.ok(briefing.includes('platform.handoff_ack'))
  })

  await check('human recipient: inbox row, no agent memory write', async () => {
    const { memory, handoffs, invokeArgs } = deps()
    const out = parsePayload(
      await invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: { definitionId: KATI_DEF, toUserId: ZOLI, title: 'Jóváhagyás kell', summary: 'Nézd meg.', idempotencyKey: 'h2' },
      }),
    )
    assert.equal(out.ok, true)
    assert.equal(out.notified, 'inbox')
    const row = await handoffs.findById(out.handoffId as string)
    assert.equal(row?.toUserId, ZOLI)
    assert.equal((await memory.listActive({ tenantId: TENANT, agentId: GABOR, projectKey: '__general__' })).length, 0)
  })

  await check('self-handoff and unknown target are rejected', async () => {
    const { invokeArgs } = deps()
    const selfOut = parsePayload(
      await invokeProjectWork(
        { ...invokeArgs, loadDefinitionByAgent: async () => katiDef },
        {
          principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
          toolName: 'platform.handoff',
          args: { definitionId: KATI_DEF, toAgentId: KATI, title: 'T', summary: 'S', idempotencyKey: 'h3' },
        },
      ),
    )
    assert.equal(selfOut.code, 'invalid_args')
    const { invokeArgs: args2 } = deps()
    const unknown = parsePayload(
      await invokeProjectWork(args2, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: { definitionId: KATI_DEF, toAgentId: globalThis.crypto.randomUUID(), title: 'T', summary: 'S', idempotencyKey: 'h4' },
      }),
    )
    assert.equal(unknown.code, 'definition_not_found')
  })

  await check('ack: only the recipient side may decide; closed stays closed', async () => {
    const { handoffs, invokeArgs } = deps()
    const created = parsePayload(
      await invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: { definitionId: KATI_DEF, toAgentId: GABOR, title: 'Hiba: X', summary: 'Nézd meg.', idempotencyKey: 'h5' },
      }),
    )
    const handoffId = created.handoffId as string
    const gaborArgs = {
      ...invokeArgs,
      loadDefinition: async () => gaborDef,
      findCurrentDefinitionId: async () => GABOR_DEF,
    } as Parameters<typeof invokeProjectWork>[0]
    const accepted = parsePayload(
      await invokeProjectWork(gaborArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff_ack',
        args: { definitionId: GABOR_DEF, handoffId, decision: 'accepted' },
      }),
    )
    assert.equal(accepted.ok, true)
    // Stranger (Kati side) cannot ack a handoff addressed to Gábor.
    const stranger = parsePayload(
      await invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff_ack',
        args: { definitionId: KATI_DEF, handoffId, decision: 'done' },
      }),
    )
    assert.equal(stranger.code, 'agent_access_denied')
    const done = parsePayload(
      await invokeProjectWork(gaborArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff_ack',
        args: { definitionId: GABOR_DEF, handoffId, decision: 'done' },
      }),
    )
    assert.equal(done.ok, true)
    assert.equal((await handoffs.findById(handoffId))?.status, 'done')
  })

  await check('cross-tenant handoff row is invisible', async () => {
    const { invokeArgs, handoffs } = deps()
    const { handoff: inserted } = await handoffs.insert({
      tenantId: OTHER_TENANT,
      fromAgentId: KATI,
      fromDefinitionId: KATI_DEF,
      toAgentId: GABOR,
      toUserId: null,
      projectKey: '__general__',
      title: 'Idegen',
      summary: 'Nem láthatod.',
      links: null,
      createdById: ANNA,
    })
    const out = parsePayload(
      await invokeProjectWork(
        { ...invokeArgs, loadDefinition: async () => gaborDef, findCurrentDefinitionId: async () => GABOR_DEF },
        {
          principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
          toolName: 'platform.handoff_ack',
          args: { definitionId: GABOR_DEF, handoffId: inserted.id, decision: 'done' },
        },
      ),
    )
    assert.equal(out.code, 'definition_not_found')
  })

  await check('memory body format stamps the source agent', () => {
    const body = formatHandoffMemoryBody({ fromAgentName: 'Kati', summary: 'S', links: null, handoffId: 'h-1' })
    assert.ok(body.includes('Kati') && body.includes('h-1'))
  })

  await check('parseHandoffLinks splits label | href pairs', () => {
    const parsed = parseHandoffLinks('Ajánlat | work_file:/plans/acme.md, Doc | https://example.com/x, sima')
    assert.equal(parsed.length, 3)
    assert.equal(parsed[0]?.kind, 'work_file')
    assert.equal(parsed[1]?.kind, 'url')
    assert.equal(parsed[1]?.href, 'https://example.com/x')
    assert.equal(parsed[2]?.kind, 'other')
    assert.deepEqual(parseHandoffLinks(null), [])
  })

  await check('Kati → ember e-mail-címmel: a szerver feloldja a tenant aktív tagjára', async () => {
    const { handoffs, invokeArgs } = deps({
      findTenantMemberByEmail: async (input: { tenantId: string; email: string }) =>
        input.tenantId === TENANT && input.email === 'csilla.szabo@excellencepay.com' ? { userId: ZOLI } : null,
    })
    const call = (args: Record<string, unknown>) =>
      invokeProjectWork(invokeArgs, {
        principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
        toolName: 'platform.handoff',
        args: { definitionId: KATI_DEF, title: 'Frissítés kész', summary: 'Nézd meg.', idempotencyKey: 'h-mail', ...args },
      })
    const ok = parsePayload(await call({ toUserEmail: ' Csilla.Szabo@ExcellencePay.com ' }))
    assert.equal(ok.ok, true)
    assert.equal((await handoffs.findById(ok.handoffId as string))?.toUserId, ZOLI)
    assert.equal(ok.notified, 'inbox')

    const unknown = await call({ toUserEmail: 'kivul.allo@example.com' })
    assert.equal(unknown.isError, true)
    assert.equal(parsePayload(unknown).error ?? parsePayload(unknown).code, 'agent_access_denied')

    const both = await call({ toUserEmail: 'csilla.szabo@excellencepay.com', toUserId: ZOLI })
    assert.equal(both.isError, true)
  })

  await check('toUserEmail feloldó nélkül nem csendes siker', async () => {
    const { invokeArgs } = deps()
    const result = await invokeProjectWork(invokeArgs, {
      principal: { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false },
      toolName: 'platform.handoff',
      args: { definitionId: KATI_DEF, toUserEmail: 'csilla.szabo@excellencepay.com', title: 'T', summary: 'S', idempotencyKey: 'h-no-resolver' },
    })
    assert.equal(result.isError, true)
  })

  if (failures > 0) {
    console.log(`\n${failures} kudarc`)
    process.exit(1)
  }
  console.log('\nMinden handoff-teszt átment.')
}

void main()
