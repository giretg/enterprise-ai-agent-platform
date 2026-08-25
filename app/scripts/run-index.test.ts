/**
 * RA-03 — `run_index` tool (szkóp-feloldás, futás-fejlécek).
 * Futtatás: npm run test:run-index
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUN_INDEX_NOT_FOUND,
  RunIndexNotFoundError,
  selectRunIndexCandidates,
} from '../src/domain/run-analysis/run-index-service'
import {
  TOOL_GROUP_ANALYSIS,
  TOOL_REGISTRY,
} from '../src/domain/tool-broker/tool-registry'
import { SIDE_EFFECTING_TOOLS, TOOL_TRUST_REGISTRY } from '../src/domain/tool-broker/tool-trust-registry'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main() {
  console.log('=== RA-03 run_index ===')

  await test('selectRunIndexCandidates: legutóbbi N, dedupe grain:id szerint', () => {
    const base = Date.parse('2026-08-01T00:00:00Z')
    const { selected, truncated } = selectRunIndexCandidates(
      [
        { grain: 'turn', id: 't-old', startedAt: new Date(base) },
        { grain: 'ticket', id: 'k-1', startedAt: new Date(base + 5_000) },
        { grain: 'process', id: 'p-1', startedAt: new Date(base + 8_000) },
        { grain: 'turn', id: 't-new', startedAt: new Date(base + 10_000) },
        { grain: 'turn', id: 't-old', startedAt: new Date(base + 1_000) },
      ],
      3,
    )
    assert.equal(selected.length, 3)
    assert.equal(truncated, true)
    assert.deepEqual(
      selected.map((s) => `${s.grain}:${s.id}`),
      ['turn:t-new', 'process:p-1', 'ticket:k-1'],
    )
  })

  await test('selectRunIndexCandidates: kevesebb mint limit → truncated false', () => {
    const { truncated, selected } = selectRunIndexCandidates(
      [{ grain: 'turn', id: 'a', startedAt: new Date() }],
      5,
    )
    assert.equal(truncated, false)
    assert.equal(selected.length, 1)
  })

  await test('selectRunIndexCandidates: horgonyzott ticket nem esik ki a limit alól', () => {
    const base = Date.parse('2026-08-01T00:00:00Z')
    const { selected, truncated } = selectRunIndexCandidates(
      [
        { grain: 'ticket', id: 'requested', startedAt: new Date(base) },
        { grain: 'ticket', id: 'sibling', startedAt: new Date(base + 5_000) },
        { grain: 'process', id: 'p-1', startedAt: new Date(base + 8_000) },
      ],
      2,
      new Set(['ticket:requested']),
    )
    assert.equal(truncated, true)
    assert.equal(selected.length, 2)
    assert.ok(selected.some((s) => s.grain === 'ticket' && s.id === 'requested'))
  })

  await test('RunIndexNotFoundError: run_not_found üzenet', () => {
    const err = new RunIndexNotFoundError()
    assert.equal(err.message, RUN_INDEX_NOT_FOUND)
  })

  await test('registry: run_index chat-only, external_untrusted, Futás-elemzés csoport', () => {
    const d = TOOL_REGISTRY.run_index
    assert.deepEqual(d.surfaces, ['chat'])
    assert.equal(d.sideEffecting, false)
    assert.equal(d.trust, 'external_untrusted')
    assert.equal(d.capabilityGroup, TOOL_GROUP_ANALYSIS)
    assert.equal(d.handlerId, 'run_index')
    assert.equal(TOOL_TRUST_REGISTRY.run_index, 'external_untrusted')
    assert.equal(SIDE_EFFECTING_TOOLS.run_index, false)
  })

  await test('forrásszerződés: discoverCandidates take-korlátos', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /const take = filters\.fetchLimit/)
    assert.match(src, /fetchLimit: limit \+ 1/)
  })

  await test('forrásszerződés: ticket-horgony nem kever beszélgetés-fordulót, folyamatot kibont', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /anchoredToTicket/)
    assert.match(src, /expandTicketProcessCandidates/)
    assert.match(src, /hasHardScopeAnchor/)
    assert.match(src, /expandTicketProcessCandidates\([\s\S]*siblingTake: number/)
    assert.match(src, /orderBy: \{ createdAt: 'desc' \},\s*take: siblingTake/)
  })

  await test('forrásszerződés: run_analyst önelemzés kizárva + audit', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /RUN_ANALYST_SYSTEM_ROLE/)
    assert.match(src, /analysis\.run_index/)
    // Folyamat → ticket plafon (5000+) nem lehet néma incomplete aggregátum.
    assert.match(src, /processTicketIndexTruncated/)
  })

  await test('audit-katalógus: analysis.run_index / run_stats / run_trace regisztrálva', () => {
    for (const action of ['analysis.run_index', 'analysis.run_stats', 'analysis.run_trace'] as const) {
      assert.equal(REGISTERED_AUDIT_ACTIONS.has(action), true, action)
    }
  })

  const NIL = '00000000-0000-0000-0000-000000000000'
  const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  const TICKET = '929ae6a1-ee80-40a6-a045-eb8a735a3f12'
  const CONVERSATION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  const PROCESS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  const invokeCtx = {
    agentId: '70a0d096-acf0-48b5-811d-46b821b56c44',
    agentVersion: 1,
  }

  await test('toInvokeInput: nil UUID kísérőmezők nem írják felül a ticket-horgonyt', () => {
    const input = TOOL_REGISTRY.run_index.toInvokeInput(
      {
        ticketId: TICKET,
        agentId: NIL,
        conversationId: NIL,
        processInstanceId: NIL,
        playbookVersionId: NIL,
        limit: 20,
      },
      invokeCtx,
    )
    assert.equal(input.tool, 'run_index')
    assert.equal(input.args.ticketId, TICKET)
    assert.equal(input.args.agentId, undefined)
    assert.equal(input.args.conversationId, undefined)
    assert.equal(input.args.processInstanceId, undefined)
    assert.equal(input.args.playbookVersionId, undefined)
    assert.equal(input.args.limit, 20)
  })

  await test('toInvokeInput: nil UUID kísérőmezők nem írják felül a beszélgetés-horgonyt', () => {
    const input = TOOL_REGISTRY.run_index.toInvokeInput(
      {
        conversationId: CONVERSATION,
        ticketId: NIL,
        agentId: NIL,
        processInstanceId: NIL,
        playbookVersionId: NIL,
      },
      invokeCtx,
    )
    assert.equal(input.args.conversationId, CONVERSATION)
    assert.equal(input.args.ticketId, undefined)
  })

  await test('toInvokeInput: nil UUID kísérőmezők nem írják felül a folyamat-horgonyt', () => {
    const input = TOOL_REGISTRY.run_index.toInvokeInput(
      {
        processInstanceId: PROCESS,
        ticketId: NIL,
        conversationId: NIL,
        agentId: NIL,
        playbookVersionId: NIL,
      },
      invokeCtx,
    )
    assert.equal(input.args.processInstanceId, PROCESS)
    assert.equal(input.args.ticketId, undefined)
    assert.equal(input.args.conversationId, undefined)
  })

  await test('toInvokeInput: ticketIds lista + nil ticketId — a lista marad', () => {
    const input = TOOL_REGISTRY.run_index.toInvokeInput(
      {
        ticketId: NIL,
        ticketIds: [TICKET, NIL],
        agentId: NIL,
        conversationId: NIL,
        processInstanceId: NIL,
        playbookVersionId: NIL,
        limit: 50,
      },
      invokeCtx,
    )
    assert.deepEqual(input.args.ticketIds, [TICKET])
    assert.equal(input.args.ticketId, undefined)
  })

  await test('toInvokeInput: max UUID (ffffffff-…) sem horgony', () => {
    const input = TOOL_REGISTRY.run_index.toInvokeInput(
      {
        ticketId: TICKET,
        agentId: MAX_UUID,
        conversationId: MAX_UUID,
        processInstanceId: MAX_UUID,
        playbookVersionId: MAX_UUID,
        agentQuery: 'Adatok értelmezése és feltöltése az Ostoros Föld API-n',
        limit: 20,
      },
      invokeCtx,
    )
    assert.equal(input.args.ticketId, TICKET)
    assert.equal(input.args.agentId, undefined)
    assert.equal(input.args.conversationId, undefined)
    assert.equal(input.args.processInstanceId, undefined)
    assert.equal(input.args.playbookVersionId, undefined)
  })

  await test('toInvokeInput: run_stats ugyanúgy eldobja a nil UUID-t', () => {
    const input = TOOL_REGISTRY.run_stats.toInvokeInput(
      {
        ticketId: TICKET,
        agentId: NIL,
        conversationId: NIL,
        processInstanceId: NIL,
        playbookVersionId: NIL,
      },
      invokeCtx,
    )
    assert.equal(input.tool, 'run_stats')
    assert.equal(input.args.ticketId, TICKET)
    assert.equal(input.args.agentId, undefined)
    assert.equal(input.args.conversationId, undefined)
  })

  await test('forrásszerződés: nil UUID szkópmezőt a service is ki nem töltöttnek veszi', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /normalizeRunIndexArgs/)
    const scopeSrc = readFileSync(join(root, 'src/domain/run-analysis/run-scope.ts'), 'utf8')
    assert.match(scopeSrc, /presentScopeId/)
    assert.match(scopeSrc, /00000000-0000-0000-0000-000000000000/)
    assert.match(scopeSrc, /ffffffff-ffff-ffff-ffff-ffffffffffff/)
  })

  if (failures > 0) {
    console.error(`\n${failures} hiba`)
    process.exit(1)
  }
  console.log('\nMinden run_index teszt OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
