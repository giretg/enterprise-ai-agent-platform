/**
 * #1070 — kapcsolt rendszerből letöltött fájl (Excel/PDF/CSV) átadása: bájtként olvasva, a modell
 * kontextusa nélkül, a letölthető-fájl tárolóba mentve, fájl-kártya linkkel és auditált hash-sel.
 * Futtatás: npm run test:http-api-file-response
 */
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import type { AgentDefinition } from '../src/domain/agent-definition'
import {
  HttpApiClient as RuntimeHttpApiClient,
  HttpApiError,
  parseHttpApiConfig,
  type HttpApiConfig,
} from '../src/domain/connector/http-api-client'
import { contentDispositionFileName, detectHttpApiFile, HTTP_API_FILE_MAX_BYTES, sha256Hex, type HttpApiFile } from '../src/domain/connector/http-api-file'
import { executeHttpApiTool, type SaveHttpApiFile } from '../src/domain/enterprise-tools/handlers/http-api'
import { HTTP_API_GET_TOOL, invokeEnterpriseTool, type EnterpriseToolDeps } from '../src/domain/enterprise-tools'

class HttpApiClient extends RuntimeHttpApiClient {
  constructor(config: HttpApiConfig) {
    super(config, 'crm-key', async () => ['8.8.8.8'])
  }
}

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const config = parseHttpApiConfig({
  baseUrl: 'https://crm.example.test/api/connector/v1',
  auth: { scheme: 'bearer' },
  endpoints: [
    { method: 'GET', path: '/reports/exports/:id/download' },
    { method: 'GET', path: '/reports/query' },
  ],
  restrictToEndpoints: true,
})

async function withFetch<T>(response: () => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => response()) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

async function xlsxBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('BIB 3l')
  ws.addRow(['Partner', 'Hónap', 'Liter'])
  ws.addRow(['Árvíztűrő Kft.', '2025-01', 120])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// Nem érvényes UTF-8 bájtok: a régi `res.text()` ezeket `�`-re cserélte volna.
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x80, 0xff, 0x00]), Buffer.from('\n%%EOF\n')])

async function main() {
  console.log('http_api fájl-válasz (#1070)')

  await check('content-disposition: filename* (UTF-8) elsőbbséget kap', () => {
    assert.equal(
      contentDispositionFileName(`attachment; filename="BIB_3l.xlsx"; filename*=UTF-8''BIB%203l%20%C3%A1rv%C3%ADzt%C5%B1r%C5%91.xlsx`),
      'BIB 3l árvíztűrő.xlsx',
    )
  })

  await check('content-disposition: a latin-1-ként olvasott UTF-8 ékezetes név helyreáll', () => {
    const raw = Buffer.from('attachment; filename="Eladások 2025.xlsx"', 'utf8').toString('latin1')
    assert.equal(contentDispositionFileName(raw), 'Eladások 2025.xlsx')
  })

  await check('fájlnév: útvonal nélkül; hiányzó névnél a típus szerinti kiterjesztés', () => {
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../etc/riport"' }))?.fileName, 'riport.pdf')
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': XLSX_MIME }))?.fileName, 'letoltes.xlsx')
  })

  await check('felismerés: JSON és sima szöveg nem fájl; CSV csak attachment-tel', () => {
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'application/json' })), null)
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'text/csv' })), null)
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="a.csv"' }))?.format, 'csv')
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'application/octet-stream' }))?.format, 'bin')
    assert.equal(detectHttpApiFile(new Headers({ 'content-type': 'application/zip' }))?.format, 'zip')
  })

  await check('XLSX-válasz: ép bájtok (Excelben megnyitható), body null, nincs csonkolás', async () => {
    const bytes = await xlsxBytes()
    const res = await withFetch(
      () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': XLSX_MIME, 'content-disposition': 'attachment; filename="BIB_3l_2025.xlsx"' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/exports/e1/download' }),
    )
    assert.equal(res.body, null)
    assert.equal(res.truncated, undefined)
    assert.ok(res.file)
    assert.equal(res.file.fileName, 'BIB_3l_2025.xlsx')
    assert.equal(res.file.mimeType, XLSX_MIME)
    assert.equal(res.file.format, 'xlsx')
    assert.ok(res.file.bytes.equals(bytes))
    assert.equal(res.file.sha256, sha256Hex(bytes))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.file.bytes as unknown as ArrayBuffer)
    assert.equal(wb.getWorksheet('BIB 3l')?.getCell('A2').value, 'Árvíztűrő Kft.')
  })

  await check('PDF-válasz: a nem-UTF-8 bájtok változatlanok', async () => {
    const res = await withFetch(
      () => new Response(new Uint8Array(PDF_BYTES), { status: 200, headers: { 'content-type': 'application/pdf' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/exports/e1/download' }),
    )
    assert.ok(res.file?.bytes.equals(PDF_BYTES))
    assert.equal(res.file?.fileName, 'letoltes.pdf')
  })

  await check('CSV-attachment: fájlként jön át, nem szövegként', async () => {
    const csv = Buffer.from('﻿Partner;Liter\nÁrvíztűrő Kft.;120\n', 'utf8')
    const res = await withFetch(
      () => new Response(new Uint8Array(csv), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="bib.csv"' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/exports/e1/download' }),
    )
    assert.equal(res.body, null)
    assert.ok(res.file?.bytes.equals(csv))
    assert.equal(res.file?.mimeType, 'text/csv')
  })

  await check('túl nagy fájl: érthető file_too_large hiba (content-length és folyamatos olvasás)', async () => {
    const declared = () =>
      new Response('x', { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(HTTP_API_FILE_MAX_BYTES + 1) } })
    const streamed = () => {
      const chunk = new Uint8Array(1024 * 1024)
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > HTTP_API_FILE_MAX_BYTES) return controller.close()
          sent += chunk.byteLength
          controller.enqueue(chunk)
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    for (const response of [declared, streamed]) {
      await assert.rejects(
        withFetch(response, () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/exports/e1/download' })),
        (e: unknown) => e instanceof HttpApiError && e.code === 'file_too_large' && /túl nagy az átadáshoz/.test(e.reason ?? ''),
      )
    }
  })

  await check('regresszió: JSON- és szöveges válasz változatlan', async () => {
    const json = await withFetch(
      () => new Response(JSON.stringify({ data: { status: 'ready' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/query' }),
    )
    assert.deepEqual(json.body, { data: { status: 'ready' } })
    assert.equal(json.file, undefined)
    const text = await withFetch(
      () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/query' }),
    )
    assert.equal(text.body, 'ok')
    assert.equal(text.file, undefined)
  })

  await check('regresszió: Content-Type nélküli szöveg és üres 204 nem fájl', async () => {
    for (const response of [new Response('ok'), new Response(null, { status: 204 })]) {
      response.headers.delete('content-type')
      const res = await withFetch(() => response, () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/query' }))
      assert.equal(res.file, undefined)
      assert.equal(res.body, response.status === 204 ? '' : 'ok')
    }
    assert.equal(detectHttpApiFile(new Headers({ 'content-disposition': 'attachment; filename="report.bin"' }))?.mimeType, 'application/octet-stream')
  })

  await check('hibás válasz (4xx) attachment fejléccel sem fájl — a hiba-hint megmarad', async () => {
    const res = await withFetch(
      () => new Response('{"error":"not_ready"}', { status: 409, headers: { 'content-type': 'application/octet-stream' } }),
      () => new HttpApiClient(config).request({ method: 'GET', path: '/reports/exports/e1/download' }),
    )
    assert.equal(res.file, undefined)
    assert.equal(res.ok, false)
  })

  const connector = {
    id: 'crm-1',
    tenantId: 't1',
    type: 'http_api',
    authMode: 'api_key',
    lifecycleState: 'active',
    name: 'Ostoros CRM',
    config: {
      baseUrl: 'https://posnavigator.eu/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [{ method: 'GET', path: '/reports/exports/:id/download' }],
    },
  }
  const expiresAt = new Date('2026-11-10T10:00:00.000Z')

  await check('http_api_get eszköz: a modell csak metaadatot és linket kap, a tartalmat nem', async () => {
    const bytes = await xlsxBytes()
    const saved: HttpApiFile[] = []
    const saveFile: SaveHttpApiFile = async (file) => {
      saved.push(file)
      return { exportId: 'exp-1', downloadUrl: 'https://app.example/api/control-plane/document-exports/exp-1', expiresAt }
    }
    const result = (await withFetch(
      () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': XLSX_MIME, 'content-disposition': 'attachment; filename="BIB_3l_2025.xlsx"' } }),
      () => executeHttpApiTool('http_api_get', { path: '/reports/exports/e1/download' }, connector, 'crm-key', null, { id: 'reka' }, 'hu', undefined, saveFile),
    )) as Record<string, unknown>
    assert.equal(saved.length, 1)
    assert.ok(saved[0].bytes.equals(bytes))
    assert.equal(result.ok, true)
    assert.equal(result.exportId, 'exp-1')
    assert.equal(result.fileName, 'BIB_3l_2025.xlsx')
    assert.equal(result.sizeBytes, bytes.length)
    assert.equal(result.downloadUrl, 'https://app.example/api/control-plane/document-exports/exp-1')
    assert.equal(result.expiresAt, expiresAt.toISOString())
    assert.equal(result.body, undefined)
    const json = JSON.stringify(result)
    assert.ok(!json.includes('PK'), 'a ZIP-fejléc nem kerülhet a modellhez')
    assert.ok(json.length < 2_000)
  })

  await check('http_api_get eszköz tároló nélkül: rövid magyarázat, bináris tartalom nélkül', async () => {
    const result = (await withFetch(
      () => new Response(new Uint8Array(PDF_BYTES), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="szamla.pdf"' } }),
      () => executeHttpApiTool('http_api_get', { path: '/reports/exports/e1/download' }, connector, 'crm-key', null, { id: 'reka' }),
    )) as Record<string, unknown>
    assert.equal(result.ok, false)
    assert.deepEqual(Object.keys(result.file as object).sort(), ['fileName', 'mimeType', 'sha256', 'sizeBytes'])
    assert.match(String(result.hint), /fájlátadás nem érhető el/)
    assert.ok(!JSON.stringify(result).includes('%PDF'))
  })

  await check('invoke: tárolóba mentés a kérőhöz kötve, fájl-kártya link, audit név+méret+hash', async () => {
    const USER_ID = '11111111-1111-4111-8111-111111111111'
    const TENANT_ID = '22222222-2222-4222-8222-222222222222'
    const AGENT_ID = '33333333-3333-4333-8333-333333333333'
    const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
    const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'
    const NOW = new Date('2026-11-03T10:00:00.000Z')
    const bytes = await xlsxBytes()
    const definition: AgentDefinition = {
      definitionId: DEFINITION_ID,
      agentId: AGENT_ID,
      version: 1,
      tenantId: TENANT_ID,
      status: 'active',
      publishedAt: '2026-11-01T00:00:00.000Z',
      snapshot: {
        name: 'Réka',
        roleInstruction: 'CRM riportok',
        skills: [],
        connectors: [{ connectorId: CONNECTOR_ID, type: 'http_api', accessMode: 'read' }],
        capabilities: [{ toolName: HTTP_API_GET_TOOL, allowed: true }],
      },
    }
    const stored: Array<Record<string, unknown>> = []
    const audit: Array<{ action: string; metadata: Record<string, unknown> }> = []
    const deps = {
      async findConnector() {
        return { id: CONNECTOR_ID, tenantId: TENANT_ID, type: 'http_api', authMode: 'service', lifecycleState: 'active', name: 'Ostoros CRM', config: connector.config }
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
        return 'crm-key'
      },
      // A valódi kliens helyett: ugyanazt a fájlt adja át a platform mentőjének.
      executeHttpApiTool: async (...args: Parameters<NonNullable<EnterpriseToolDeps['executeHttpApiTool']>>) => {
        const saveFile = args[8]
        assert.ok(saveFile, 'a tároló be van kötve')
        const saved = await saveFile({ bytes, fileName: 'BIB_3l_2025.xlsx', mimeType: XLSX_MIME, format: 'xlsx', sha256: sha256Hex(bytes) })
        return { ok: true, status: 200, ...saved, expiresAt: saved.expiresAt.toISOString(), fileName: 'BIB_3l_2025.xlsx', mimeType: XLSX_MIME, sizeBytes: bytes.length, sha256: sha256Hex(bytes) }
      },
      saveDocumentExport: async (input: Record<string, unknown>) => {
        stored.push(input)
        return { id: '77777777-7777-4777-8777-777777777777' }
      },
      documentExportUrl: (id: string) => `https://app.example/api/control-plane/document-exports/${id}`,
      now: () => NOW,
      audit: {
        async append(data: { action: string; metadata: unknown }) {
          audit.push({ action: data.action, metadata: data.metadata as Record<string, unknown> })
        },
      },
    } as unknown as EnterpriseToolDeps
    const result = await invokeEnterpriseTool(deps, {
      principal: { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false },
      toolName: HTTP_API_GET_TOOL,
      args: { definitionId: DEFINITION_ID, path: '/reports/exports/e1/download' },
      client: 'platform_chat',
    })
    assert.ok('content' in result)
    assert.equal(result.isError, undefined)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].userId, USER_ID)
    assert.equal(stored[0].tenantId, TENANT_ID)
    assert.equal(stored[0].agentId, AGENT_ID)
    assert.equal(stored[0].client, 'platform_chat')
    assert.equal((stored[0].expiresAt as Date).toISOString(), '2026-11-10T10:00:00.000Z')
    assert.deepEqual(result.links, [
      {
        uri: 'https://app.example/api/control-plane/document-exports/77777777-7777-4777-8777-777777777777',
        name: 'BIB_3l_2025.xlsx',
        mimeType: XLSX_MIME,
        size: bytes.length,
        description: result.links?.[0]?.description,
      },
    ])
    assert.match(result.links?.[0]?.description ?? '', /^Letölthető fájl — 2026\. november 10\./)
    const ok = audit.find((row) => row.action === 'enterprise.tool.ok')
    assert.deepEqual(ok?.metadata.file, {
      exportId: '77777777-7777-4777-8777-777777777777',
      fileName: 'BIB_3l_2025.xlsx',
      mimeType: XLSX_MIME,
      byteSize: bytes.length,
      sha256: sha256Hex(bytes),
    })
    assert.ok(!JSON.stringify(audit).includes(bytes.toString('base64').slice(0, 40)))
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden #1070 teszt zöld.')
}

void main()
