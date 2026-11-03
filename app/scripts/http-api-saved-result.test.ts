/**
 * #1071 — nagy, de hiánytalan kapcsolati válasz: mentés a kérő usernek, lapozott olvasás,
 * Excel a mentett adatból (a modellen át-gépelés nélkül), más user / munkatárs nem látja.
 * Futtatás: npm run test:http-api-saved-result
 */
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { capHttpApiResultForModel } from '../src/domain/connector/http-api-prompt'
import {
  loadOwnSavedResult,
  readSavedResult,
  SAVED_RESULT_FORMAT,
  SAVED_RESULT_MIME,
  savedResultToSheet,
  type SaveOversizedHttpResult,
  type SavedHttpResultInfo,
} from '../src/domain/connector/http-api-saved-result'
import type { DocumentExportStore, StoredDocumentExport } from '../src/domain/document-export/document-export-store'
import {
  DOCUMENT_EXPORT_TOOL,
  HTTP_API_SAVED_READ_TOOL,
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { executeHttpApiTool } from '../src/domain/enterprise-tools/handlers/http-api'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_AGENT_ID = '55555555-5555-4555-8555-555555555555'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-11-03T10:00:00.000Z')

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

/** Memóriabeli fájl-tároló (a `document_exports` tábla helyett). */
class MemoryStore implements DocumentExportStore {
  rows = new Map<string, StoredDocumentExport & { data: Buffer }>()
  private seq = 0
  async create(input: Parameters<DocumentExportStore['create']>[0]) {
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`
    const { definitionId: _d, client: _c, ...rest } = input
    const row = { ...rest, id, createdAt: NOW }
    this.rows.set(id, row)
    const { data: _data, ...meta } = row
    return meta
  }
  async find(id: string) {
    const row = this.rows.get(id)
    if (!row) return null
    const { data: _data, ...meta } = row
    return meta
  }
  async readData(id: string) {
    return this.rows.get(id)?.data ?? null
  }
  async deleteExpired() {
    return 0
  }
}

/** A CRM `POST /reports/query` alakja: havi × partner × termék, aktuális + előző időszak. */
function bibReport(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    dimensions: {
      month: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
      'partner.name': `Partner ${Math.floor(i / 12)} Kft.`,
      'product.name': `Birtok BIB 3 l ${i % 5}`,
    },
    current: { netValue: 120_000 + i, quantity: 10 + (i % 7) },
    previous: { netValue: 100_000 + i, quantity: 8 + (i % 5) },
  }))
  return {
    data: {
      period: { from: '2025-01-01', to: '2026-10-31' },
      columns: [
        { key: 'month', role: 'dimension', label: 'Hónap' },
        { key: 'partner.name', role: 'dimension', label: 'Partner' },
        { key: 'product.name', role: 'dimension', label: 'Termék' },
        { key: 'netValue', role: 'measure', label: 'Nettó érték' },
        { key: 'quantity', role: 'measure', label: 'Mennyiség' },
      ],
      rows,
    },
    meta: { rowCount, truncated: false },
  }
}

const crmConnector = {
  id: 'crm-1',
  tenantId: TENANT_ID,
  type: 'http_api',
  authMode: 'api_key',
  lifecycleState: 'active',
  name: 'Ostoros CRM',
  config: {
    baseUrl: 'https://posnavigator.eu/api/v1',
    auth: { scheme: 'bearer' },
    endpoints: [{ method: 'POST', path: '/reports/query' }],
  },
}

async function callCrm(payload: unknown, save?: SaveOversizedHttpResult) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    return (await executeHttpApiTool(
      'http_api_request',
      { method: 'POST', path: '/reports/query', body: '{"preset":"bib-monthly"}' },
      crmConnector as never,
      'crm-key',
      null,
      { id: AGENT_ID },
      'hu',
      undefined,
      undefined,
      save ? { saveOversized: save } : undefined,
    )) as Record<string, unknown> & { savedResult?: SavedHttpResultInfo; preview?: string; hint?: string }
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** A platform mentője a memóriatárolóba (ua., mint a gateway-services bekötése). */
function saverFor(store: MemoryStore, userId = USER_ID, agentId = AGENT_ID): SaveOversizedHttpResult {
  return async ({ data }) => {
    const expiresAt = new Date(NOW.getTime() + 7 * 86_400_000)
    const row = await store.create({
      tenantId: TENANT_ID,
      userId,
      agentId,
      definitionId: DEFINITION_ID,
      client: 'platform_chat',
      fileName: 'reports-query-2026-11-03.json',
      format: SAVED_RESULT_FORMAT,
      mimeType: SAVED_RESULT_MIME,
      byteSize: data.length,
      data,
      expiresAt,
    })
    return { id: row.id, expiresAt }
  }
}

const principal: ToolCallPrincipal = { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false }
const definition: AgentDefinition = {
  definitionId: DEFINITION_ID,
  agentId: AGENT_ID,
  version: 1,
  tenantId: TENANT_ID,
  status: 'active',
  publishedAt: '2026-11-01T00:00:00.000Z',
  snapshot: { name: 'Réka', roleInstruction: 'Riportok', skills: [], connectors: [], capabilities: [] },
}

type AuditRow = { action: string; metadata: Record<string, unknown> }

function deps(store: MemoryStore, opts: { audit?: AuditRow[]; exported?: Array<Record<string, unknown>> } = {}): EnterpriseToolDeps {
  return {
    async findConnector() {
      return null
    },
    async findActiveGrant() {
      return null
    },
    async loadDefinition() {
      return definition
    },
    async findCurrentDefinitionId() {
      return DEFINITION_ID
    },
    async findAgentGrant() {
      return { accessLevel: 'operate' }
    },
    async resolveAccessToken() {
      throw new Error('saved results must not use an OAuth token')
    },
    saveDocumentExport: async (input: Record<string, unknown>) => {
      opts.exported?.push(input)
      return { id: '77777777-7777-4777-8777-777777777777' }
    },
    loadHttpResult: (input: { tenantId: string; userId: string; agentId: string; id: string }) =>
      loadOwnSavedResult(store, { ...input, now: NOW }),
    now: () => NOW,
    audit: {
      async append(data: { action: string; metadata: unknown }) {
        opts.audit?.push({ action: data.action, metadata: data.metadata as Record<string, unknown> })
      },
    },
  } as unknown as EnterpriseToolDeps
}

const invoke = (d: EnterpriseToolDeps, toolName: string, args: Record<string, unknown>, who: ToolCallPrincipal = principal) =>
  invokeEnterpriseTool(d, { principal: who, toolName, args: { definitionId: DEFINITION_ID, ...args }, client: 'platform_chat' })

const payloadOf = (result: Awaited<ReturnType<typeof invoke>>) =>
  'content' in result ? (JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>) : {}

async function main() {
  await check('150k karakteres riport: a teljes válasz mentve, a modell csak rövid előnézetet + azonosítót kap', async () => {
    const store = new MemoryStore()
    const report = bibReport(900)
    const raw = JSON.stringify(report)
    assert.ok(raw.length > 150_000, `a riport ${raw.length} karakter`)
    const result = await callCrm(report, saverFor(store))
    const saved = result.savedResult
    assert.ok(saved, JSON.stringify(result).slice(0, 500))
    assert.equal(saved.rowCount, 900)
    assert.equal(saved.arrayPath, 'body.data.rows')
    assert.ok(saved.fields.includes('dimensions.partner.name'))
    assert.ok(saved.fields.includes('previous.netValue'))
    assert.equal(result.truncated, true)
    assert.equal(result.body, undefined, 'a teljes törzs nem megy a modellnek')
    assert.ok((result.preview ?? '').length <= 4_000)
    assert.ok(JSON.stringify(result).length < 20_000, 'a modell kontextusába nem kerül 20k feletti adat')
    assert.match(result.hint ?? '', /document_export/)
    assert.match(result.hint ?? '', /http_api_saved_read/)
    assert.doesNotMatch(result.hint ?? '', /aggregált\/report végpontot/)
    // A tárolóban a TELJES, parse-olt törzs van — a modell-hint nélkül.
    const row = store.rows.get(saved.savedResultId)!
    assert.equal(row.userId, USER_ID)
    assert.equal(row.agentId, AGENT_ID)
    const stored = JSON.parse(row.data.toString('utf8')) as { body: unknown; hint?: unknown }
    assert.deepEqual(stored.body, report)
    assert.equal(stored.hint, undefined)
  })

  await check('AC: document_export a mentett forrásból → teljes Excel, helyes sorszám, a riport címkéivel', async () => {
    const store = new MemoryStore()
    const result = await callCrm(bibReport(900), saverFor(store))
    const audit: AuditRow[] = []
    const exported: Array<Record<string, unknown>> = []
    const out = await invoke(deps(store, { audit, exported }), DOCUMENT_EXPORT_TOOL, {
      format: 'xlsx',
      fileName: 'BIB 3l havi partner termék',
      title: 'BIB havi bontás',
      savedResultId: result.savedResult!.savedResultId,
    })
    assert.ok('content' in out && !out.isError, JSON.stringify(out))
    const document = exported[0]?.document as { bytes: Buffer; rowCount: number }
    assert.equal(document.rowCount, 900)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(document.bytes as unknown as ArrayBuffer)
    const sheet = wb.worksheets[0]!
    assert.equal(sheet.name, 'BIB havi bontás')
    assert.equal(sheet.rowCount, 901, 'fejléc + 900 sor')
    const headers = (sheet.getRow(1).values as unknown[]).slice(1)
    assert.deepEqual(headers, [
      'Hónap',
      'Partner',
      'Termék',
      'Nettó érték (current)',
      'Mennyiség (current)',
      'Nettó érték (previous)',
      'Mennyiség (previous)',
    ])
    assert.equal(sheet.getCell('B901').value, 'Partner 74 Kft.')
    assert.equal(sheet.getCell('D901').value, 120_899)
    assert.equal(audit[0]?.metadata.fromSavedResult, true)
    assert.equal(audit[0]?.metadata.rowCount, 900)
  })

  await check('document_export: columns választ és nevez, több mentés = több munkalap', async () => {
    const store = new MemoryStore()
    const a = await callCrm(bibReport(700), saverFor(store))
    const b = await callCrm(bibReport(800), saverFor(store))
    const exported: Array<Record<string, unknown>> = []
    const out = await invoke(deps(store, { exported }), DOCUMENT_EXPORT_TOOL, {
      format: 'xlsx',
      fileName: 'BIB',
      savedResultId: `${a.savedResult!.savedResultId}, ${b.savedResult!.savedResultId}`,
      columns: JSON.stringify([{ path: 'dimensions.partner.name', header: 'Vevő' }, 'current.netValue']),
    })
    assert.ok('content' in out && !out.isError, JSON.stringify(out))
    const document = exported[0]?.document as { bytes: Buffer; rowCount: number }
    assert.equal(document.rowCount, 1_500)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(document.bytes as unknown as ArrayBuffer)
    assert.equal(wb.worksheets.length, 2)
    assert.deepEqual((wb.worksheets[1]!.getRow(1).values as unknown[]).slice(1), ['Vevő', 'Nettó érték'])
  })

  await check('láthatóság: más user és másik munkatárs nem éri el a mentett választ', async () => {
    const store = new MemoryStore()
    const result = await callCrm(bibReport(900), saverFor(store))
    const id = result.savedResult!.savedResultId
    const other: ToolCallPrincipal = { ...principal, userId: OTHER_USER_ID }
    for (const [who, toolName, args] of [
      [other, HTTP_API_SAVED_READ_TOOL, { savedResultId: id }],
      [other, DOCUMENT_EXPORT_TOOL, { format: 'xlsx', fileName: 'x', savedResultId: id }],
    ] as const) {
      const out = await invoke(deps(store), toolName, args, who)
      assert.equal(payloadOf(out).code, 'saved_result_not_found')
    }
    // Másik munkatársnál mentett válasz (más connector-jogok) sem olvasható ezzel a munkatárssal.
    const foreign = await callCrm(bibReport(900), saverFor(store, USER_ID, OTHER_AGENT_ID))
    const out = await invoke(deps(store), HTTP_API_SAVED_READ_TOOL, { savedResultId: foreign.savedResult!.savedResultId })
    assert.equal(payloadOf(out).code, 'saved_result_not_found')
    // Lejárat után sem.
    assert.equal(
      await loadOwnSavedResult(store, { tenantId: TENANT_ID, userId: USER_ID, agentId: AGENT_ID, id, now: new Date(NOW.getTime() + 8 * 86_400_000) }),
      null,
    )
  })

  await check('http_api_saved_read: lapozva, a plafon alatt, nextOffset-tel', async () => {
    const store = new MemoryStore()
    const result = await callCrm(bibReport(900), saverFor(store))
    const audit: AuditRow[] = []
    const first = payloadOf(await invoke(deps(store, { audit }), HTTP_API_SAVED_READ_TOOL, { savedResultId: result.savedResult!.savedResultId, limit: 50 }))
    assert.equal(first.totalRows, 900)
    assert.equal(first.returnedRows, 50)
    assert.equal(first.nextOffset, 50)
    assert.equal(audit[0]?.action, 'enterprise.tool.ok')
    assert.ok(!JSON.stringify(audit).includes('Partner 0'), 'az audit nem tartalmaz adatot')
    // Nagy limit: a válasz 20k alatt marad, kevesebb sor jön.
    const big = payloadOf(await invoke(deps(store), HTTP_API_SAVED_READ_TOOL, { savedResultId: result.savedResult!.savedResultId, offset: 0, limit: 1000 }))
    assert.ok(JSON.stringify(big).length < 20_000)
    assert.ok((big.returnedRows as number) > 0 && (big.returnedRows as number) < 900)
    assert.equal(big.nextOffset, big.returnedRows)
    const last = readSavedResult(store.rows.get(result.savedResult!.savedResultId)!.data, { offset: 890, limit: 100, maxChars: 20_000 })
    assert.ok('rows' in last && last.returnedRows === 10 && last.nextOffset === null)
  })

  await check('sorlista nélküli nagy válasz: szövegszeletek, a mentés így is megvan', async () => {
    const store = new MemoryStore()
    const result = await callCrm({ report: 'x'.repeat(60_000) }, saverFor(store))
    assert.equal(result.savedResult?.rowCount, null)
    const page = readSavedResult(store.rows.get(result.savedResult!.savedResultId)!.data, { maxChars: 20_000 })
    assert.ok('text' in page && page.text.length > 0 && page.nextOffset === page.text.length)
    assert.ok(JSON.stringify(page).length <= 20_000)
  })

  await check('hosszú, escape-elt sor és szöveg hiánytalanul lapozható 20k alatt', async () => {
    for (const payload of [{ report: '\\"'.repeat(30_000) }, { rows: [{ report: '\\"'.repeat(30_000) }] }]) {
      const store = new MemoryStore()
      const saved = await callCrm(payload, saverFor(store))
      const id = saved.savedResult!.savedResultId
      let offset = 0
      let restored = ''
      do {
        const page = payloadOf(await invoke(deps(store), HTTP_API_SAVED_READ_TOOL, { savedResultId: id, offset, asText: offset > 0 }))
        assert.ok(JSON.stringify(page).length <= 20_000)
        assert.equal(page.asText, true)
        restored += page.text
        if (page.nextOffset === null) break
        assert.ok(Number(page.nextOffset) > offset)
        offset = Number(page.nextOffset)
      } while (true)
      assert.equal(restored, store.rows.get(id)!.data.toString('utf8'))
    }
  })

  await check('a belső mentett JSON Drive exportId-ként sem olvasható', async () => {
    const store = new MemoryStore()
    const saved = await callCrm(bibReport(900), saverFor(store))
    const wired = deps(store)
    wired.enqueueWrite = async () => { throw new Error('restricted JSON must not reach Drive') }
    wired.loadOwnDocumentExport = async () => ({ fileName: 'raw.json', mimeType: 'application/json', format: 'json', data: Buffer.from('secret') })
    const out = await invoke(wired, 'google_drive_upload_file', { exportId: saved.savedResult!.savedResultId })
    assert.equal(payloadOf(out).code, 'document_export_not_found')
  })

  await check('mentés nélkül (nincs tároló / hibás válasz): régi előnézet; riport-végponton nem az „aggregált végpont” tanács', async () => {
    const result = await callCrm(bibReport(900))
    assert.equal(result.savedResult, undefined)
    assert.ok((result.preview ?? '').length <= 20_000)
    assert.match(result.hint ?? '', /már aggregált\/riport végpont/)
    const plain = capHttpApiResultForModel({ result: { ok: true, body: 'y'.repeat(30_000) }, maxChars: 20_000, path: '/orders' }) as { hint: string }
    assert.match(plain.hint, /aggregált\/report végpontot/)
    // Hibás upstream válasz nem adat — nem mentjük.
    const store = new MemoryStore()
    const saver = saverFor(store)
    const { saveOversizedHttpResult } = await import('../src/domain/connector/http-api-saved-result')
    assert.equal(
      await saveOversizedHttpResult({ result: { ok: false, status: 500, body: 'z'.repeat(30_000) }, maxChars: 20_000, path: '/x', toolName: 'http_api_get', save: saver }),
      null,
    )
    assert.equal(store.rows.size, 0)
  })

  await check('a mentés hibája nem buktatja a hívást', async () => {
    const result = await callCrm(bibReport(900), async () => {
      throw new Error('db down')
    })
    assert.equal(result.savedResult, undefined)
    assert.equal(result.truncated, true)
  })

  await check('savedResultToSheet: tömb-sorok a columns címkéivel; rossz arrayPath érthető hiba', () => {
    const data = Buffer.from(JSON.stringify({ body: { columns: ['Hónap', 'Összeg'], rows: [['2025-01', 1], ['2025-02', 2]] } }))
    const sheet = savedResultToSheet(data, { name: 'x' })
    assert.deepEqual(sheet.headers, ['Hónap', 'Összeg'])
    assert.equal(sheet.rows.length, 2)
    assert.throws(() => savedResultToSheet(data, { name: 'x', arrayPath: 'body.nope' }), /nem sorlista/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden #1071 teszt zöld.')
}

void main()
