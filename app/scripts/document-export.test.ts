/**
 * #1024 — letölthető fájl (document_export): előállítás, korlátok, policy, letöltési jog, Drive-mentés.
 * Futtatás: npm run test:document-export
 */
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { PRESETS, type PresetId } from '../src/domain/client-policy/capabilities'
import { disabledToolsetsForPolicies } from '../src/domain/client-policy/machine-floor'
import type { ToolRule } from '../src/domain/client-policy/resolve-effective-policy'
import { DocumentExportError, exportFileName, renderDocument } from '../src/domain/document-export/document-export'
import { decideExportDownload, loadOwnExport, type DocumentExportStore, type StoredDocumentExport } from '../src/domain/document-export/document-export-store'
import { pdfSafe } from '../src/domain/document-export/render-pdf'
import {
  DOCUMENT_EXPORT_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { harnessSubstituteFor, isSubstituteVisible } from '../src/domain/enterprise-tools/harness-substitutes'
import { loadPdfParse } from '../src/lib/pdf-parse'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const EXPORT_ID = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-10-31T10:00:00.000Z')

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

const SHEETS = JSON.stringify([
  {
    name: 'Havi összesítő',
    headers: ['Hónap', 'Dátum', 'Összeg', 'Arány', 'Megjegyzés'],
    rows: [
      ['Január', '2025-01-31', 125000, 0.25, '=HYPERLINK("http://x")'],
      ['Február', '2025-02-28', 98500.5, 0.125, null],
    ],
    numberFormats: { Összeg: '#,##0 "Ft"', Arány: '0.0%' },
  },
])
const MARKDOWN = '# Összefoglaló — árvíztűrő tükörfúrógép\n\nSzöveg **félkövér** részlettel.\n\n- első\n- második\n\n| Hónap | Összeg |\n|---|---|\n| Január | 125 000 |\n'

const principal: ToolCallPrincipal = { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false }
const definition: AgentDefinition = {
  definitionId: DEFINITION_ID,
  agentId: AGENT_ID,
  version: 1,
  tenantId: TENANT_ID,
  status: 'active',
  publishedAt: '2026-10-31T00:00:00.000Z',
  snapshot: { name: 'Elemző', roleInstruction: 'Készíts riportot', skills: [], connectors: [], capabilities: [] },
}

type AuditRow = { action: string; outputRef?: string | null; metadata: Record<string, unknown> }

function deps(opts: {
  preset?: PresetId
  toolRules?: ToolRule[]
  audit?: AuditRow[]
  saved?: unknown[]
  noStore?: boolean
  enqueued?: Array<Record<string, unknown>>
  ownExport?: { fileName: string; mimeType: string; data: Buffer } | null
}): EnterpriseToolDeps {
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
      throw new Error('document_export must not use an OAuth token')
    },
    ...(opts.preset ? { resolveClientPolicy: async () => ({ capabilities: PRESETS[opts.preset!], toolRules: opts.toolRules ?? [] }) } : {}),
    ...(opts.noStore
      ? {}
      : {
          saveDocumentExport: async (input: unknown) => {
            opts.saved?.push(input)
            return { id: EXPORT_ID }
          },
        }),
    documentExportUrl: (id: string) => `https://app.example/api/control-plane/document-exports/${id}`,
    loadOwnDocumentExport: async (input: { userId: string; exportId: string }) =>
      input.userId === USER_ID && input.exportId === EXPORT_ID ? (opts.ownExport ?? null) : null,
    enqueueWrite: async (input: { args: Record<string, unknown> }) => {
      opts.enqueued?.push(input.args)
      return { content: [{ type: 'text', text: '{"status":"pending_approval"}' }] }
    },
    now: () => NOW,
    audit: {
      async append(data) {
        opts.audit?.push({ action: data.action, outputRef: data.outputRef, metadata: data.metadata as Record<string, unknown> })
      },
    },
  } as unknown as EnterpriseToolDeps
}

const call = (d: EnterpriseToolDeps, args: Record<string, unknown>, toolName = DOCUMENT_EXPORT_TOOL) =>
  invokeEnterpriseTool(d, { principal, toolName, args: { definitionId: DEFINITION_ID, ...args }, client: 'hermes' })

const payloadOf = (result: Awaited<ReturnType<typeof call>>) =>
  'content' in result ? (JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>) : {}

const stored = (overrides: Partial<StoredDocumentExport> = {}): StoredDocumentExport => ({
  id: EXPORT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  agentId: AGENT_ID,
  fileName: 'Riport.xlsx',
  format: 'xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  byteSize: 10,
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
  ...overrides,
})

async function main() {
  await check('xlsx: bold frozen header, filter, number/percent/date formats, text never becomes a formula', async () => {
    const doc = await renderDocument({ format: 'xlsx', fileName: 'Számlák 2025', sheets: SHEETS })
    assert.equal(doc.fileName, 'Számlák 2025.xlsx')
    assert.equal(doc.rowCount, 2)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(doc.bytes as unknown as ArrayBuffer)
    const sheet = wb.worksheets[0]
    assert.equal(sheet.name, 'Havi összesítő')
    assert.equal(sheet.getRow(1).getCell(1).font?.bold, true)
    assert.equal(sheet.views[0]?.state, 'frozen')
    assert.ok(sheet.autoFilter, 'autofilter on the header')
    assert.ok(sheet.getCell('B2').value instanceof Date, 'ISO date → Excel date')
    assert.equal(sheet.getCell('B2').numFmt, 'yyyy.mm.dd.')
    assert.equal(sheet.getCell('C2').numFmt, '#,##0 "Ft"')
    assert.equal(sheet.getCell('D3').numFmt, '0.0%')
    assert.equal(sheet.getCell('E2').value, '=HYPERLINK("http://x")')
    assert.equal(sheet.getCell('E2').formula, undefined)
    assert.ok((sheet.getColumn(5).width ?? 0) > 10, 'column width follows the content')
  })

  await check('csv: UTF-8 BOM, formula-looking text is neutralised, one sheet only', async () => {
    const doc = await renderDocument({ format: 'csv', fileName: 'export', sheets: SHEETS })
    const text = doc.bytes.toString('utf8')
    assert.ok(text.startsWith('﻿Hónap,Dátum'))
    assert.match(text, /"'=HYPERLINK\(""http:\/\/x""\)"/)
    await assert.rejects(
      renderDocument({ format: 'csv', fileName: 'x', sheets: JSON.stringify([{ rows: [[1]] }, { rows: [[2]] }]) }),
      (e: unknown) => e instanceof DocumentExportError && e.code === 'document_export_invalid_content',
    )
  })

  await check('docx: headings, list and table end up in the Word document', async () => {
    const doc = await renderDocument({ format: 'docx', fileName: 'Összefoglaló', title: 'Éves riport', markdown: MARKDOWN })
    const xml = await (await JSZip.loadAsync(doc.bytes)).file('word/document.xml')!.async('string')
    assert.match(xml, /árvíztűrő tükörfúrógép/)
    assert.match(xml, /Heading1|Title/)
    assert.match(xml, /<w:tbl>/)
    assert.match(xml, /félkövér/)
  })

  await check('pdf: Hungarian accents survive (ő, ű) and the table text is extractable', async () => {
    const doc = await renderDocument({ format: 'pdf', fileName: 'Összefoglaló', markdown: MARKDOWN })
    assert.equal(doc.bytes.subarray(0, 5).toString(), '%PDF-')
    const PDFParse = await loadPdfParse()
    const parser = new PDFParse({ data: new Uint8Array(doc.bytes) })
    const text = (await parser.getText()).text
    await parser.destroy()
    assert.match(text, /árvíztűrő tükörfúrógép/)
    assert.match(text, /125 000/)
    assert.equal(pdfSafe('a🚀b\tж'), 'ab    ?')
  })

  await check('md: the markdown text, with the title on top', async () => {
    const doc = await renderDocument({ format: 'md', fileName: 'jegyzet.md', title: 'Jegyzet', markdown: 'Szöveg' })
    assert.equal(doc.fileName, 'jegyzet.md')
    assert.equal(doc.bytes.toString('utf8'), '# Jegyzet\n\nSzöveg\n')
  })

  await check('limits: more than 100 000 rows, broken JSON and missing content are plain errors', async () => {
    const big = JSON.stringify([{ headers: ['a'], rows: Array.from({ length: 100_001 }, () => [1]) }])
    await assert.rejects(renderDocument({ format: 'xlsx', fileName: 'x', sheets: big }), (e: unknown) => e instanceof DocumentExportError && e.code === 'document_export_too_large')
    await assert.rejects(renderDocument({ format: 'xlsx', fileName: 'x', sheets: '{nem json' }), (e: unknown) => e instanceof DocumentExportError && e.code === 'document_export_invalid_content')
    await assert.rejects(renderDocument({ format: 'pdf', fileName: 'x' }), (e: unknown) => e instanceof DocumentExportError && e.code === 'document_export_invalid_content')
  })

  await check('file name: no path or control characters, the right extension', () => {
    assert.equal(exportFileName('../../etc/passwd', 'pdf'), 'etc passwd.pdf')
    assert.equal(exportFileName('Riport.docx', 'pdf'), 'Riport.pdf')
    assert.equal(exportFileName('  ', 'xlsx'), 'dokumentum.xlsx')
    assert.equal(exportFileName('a\u0000b"c', 'csv'), 'a b c.csv')
  })

  await check('policy: callable on every local_files level (also Kötött pálya); listed where the client cannot write files', () => {
    const sub = harnessSubstituteFor(DOCUMENT_EXPORT_TOOL)!
    const visible = (preset: PresetId, client: 'platform_chat' | 'hermes' | 'external', externalClientsEnabled = false) =>
      isSubstituteVisible(sub, { policy: { capabilities: PRESETS[preset], toolRules: [] }, client, externalClientsEnabled })
    assert.equal(visible('bound', 'hermes'), true)
    assert.equal(visible('standard', 'hermes'), true)
    assert.equal(visible('free', 'hermes'), false)
    assert.equal(visible('free', 'platform_chat'), true)
    assert.equal(visible('standard', 'external'), false)
    assert.equal(visible('standard', 'external', true), true)
  })

  await check('machine floor: the Hermes file toolset stays where it can read (document_export only adds)', () => {
    assert.ok(!disabledToolsetsForPolicies([{ capabilities: PRESETS.standard }]).includes('file'))
    assert.ok(disabledToolsetsForPolicies([{ capabilities: PRESETS.bound }]).includes('file'))
  })

  await check('AC6: Kötött pálya Hermes user gets a downloadable file — resource_link + audit without content', async () => {
    const audit: AuditRow[] = []
    const saved: Array<Record<string, unknown>> = []
    const result = await call(deps({ audit, saved }), { format: 'xlsx', fileName: 'Számlák', sheets: SHEETS })
    assert.ok('content' in result && !result.isError, JSON.stringify(result))
    const payload = payloadOf(result)
    assert.equal(payload.exportId, EXPORT_ID)
    assert.equal(payload.downloadUrl, `https://app.example/api/control-plane/document-exports/${EXPORT_ID}`)
    assert.equal(payload.expiresAt, '2026-11-07T10:00:00.000Z')
    assert.equal(result.links?.[0]?.name, 'Számlák.xlsx')
    assert.equal(result.links?.[0]?.uri, payload.downloadUrl)
    assert.equal(saved[0]?.userId, USER_ID)
    assert.equal((saved[0]?.expiresAt as Date).toISOString(), '2026-11-07T10:00:00.000Z')
    assert.equal(audit[0]?.action, 'enterprise.tool.ok')
    assert.equal(audit[0]?.metadata.capability, 'local_files')
    assert.equal(audit[0]?.metadata.policyLevel, 'none')
    assert.equal(audit[0]?.metadata.rowCount, 2)
    assert.ok(!JSON.stringify(audit).includes('Január'), 'the audit row has no file content')
  })

  await check('policy: tenant deny and approve rules stop the tool (kill-switch, no server-side approval)', async () => {
    for (const action of ['deny', 'approve'] as const) {
      const audit: AuditRow[] = []
      const saved: unknown[] = []
      const result = await call(deps({ preset: 'standard', toolRules: [{ pattern: 'document_export', action, source: 'tenant' }], audit, saved }), {
        format: 'md',
        fileName: 'x',
        markdown: 'y',
      })
      assert.equal(payloadOf(result).code, 'document_export_not_allowed_by_policy')
      assert.equal(saved.length, 0)
      assert.equal(audit[0]?.action, 'enterprise.tool.denied')
    }
  })

  await check('errors: bad content and missing store are plain codes', async () => {
    assert.equal(payloadOf(await call(deps({}), { format: 'xlsx', fileName: 'x', sheets: 'nem json' })).code, 'document_export_invalid_content')
    assert.equal(payloadOf(await call(deps({}), { format: 'exe', fileName: 'x' })).code, 'invalid_args')
    assert.equal(payloadOf(await call(deps({ noStore: true }), { format: 'md', fileName: 'x', markdown: 'y' })).code, 'tool_not_configured')
  })

  await check('AC3/AC4: only the requester (or an admin with insight) can download; expiry shows only to them', () => {
    const owner = { userId: USER_ID, activeTenantId: TENANT_ID, role: 'operator', adminInsight: false }
    assert.deepEqual(decideExportDownload(stored(), owner, NOW), { ok: true, asAdmin: false })
    assert.deepEqual(decideExportDownload(stored(), { ...owner, userId: OTHER_USER_ID }, NOW), { ok: false, reason: 'not_found' })
    assert.deepEqual(decideExportDownload(stored(), { ...owner, userId: OTHER_USER_ID, role: 'admin' }, NOW), { ok: false, reason: 'not_found' })
    assert.deepEqual(decideExportDownload(stored(), { ...owner, userId: OTHER_USER_ID, role: 'admin', adminInsight: true }, NOW), { ok: true, asAdmin: true })
    assert.deepEqual(decideExportDownload(stored(), { ...owner, activeTenantId: 'other' }, NOW), { ok: false, reason: 'not_found' })
    const expired = stored({ expiresAt: NOW })
    assert.deepEqual(decideExportDownload(expired, owner, NOW), { ok: false, reason: 'expired' })
    assert.deepEqual(decideExportDownload(expired, { ...owner, userId: OTHER_USER_ID }, NOW), { ok: false, reason: 'not_found' })
    assert.deepEqual(decideExportDownload(null, owner, NOW), { ok: false, reason: 'not_found' })
  })

  await check('loadOwnExport: only the requester, only while it lives', async () => {
    const store: DocumentExportStore = {
      create: async () => stored(),
      find: async (id) => (id === EXPORT_ID ? stored() : null),
      readData: async () => Buffer.from('xlsx-bytes'),
      deleteExpired: async () => 0,
    }
    const own = await loadOwnExport(store, { tenantId: TENANT_ID, userId: USER_ID, exportId: EXPORT_ID, now: NOW })
    assert.equal(own?.data.toString(), 'xlsx-bytes')
    assert.equal(await loadOwnExport(store, { tenantId: TENANT_ID, userId: OTHER_USER_ID, exportId: EXPORT_ID, now: NOW }), null)
    assert.equal(await loadOwnExport(store, { tenantId: TENANT_ID, userId: USER_ID, exportId: EXPORT_ID, now: new Date(NOW.getTime() + 8 * 86_400_000) }), null)
  })

  await check('AC5: Mentés a Drive-ra — exportId becomes the file bytes before the usual approval', async () => {
    const enqueued: Array<Record<string, unknown>> = []
    const ownExport = { fileName: 'Riport.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: Buffer.from('xlsx-bytes') }
    await call(deps({ enqueued, ownExport }), { name: '', exportId: EXPORT_ID, idempotencyKey: 'k1' }, GOOGLE_DRIVE_UPLOAD_FILE_TOOL)
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0].contentBase64, Buffer.from('xlsx-bytes').toString('base64'))
    assert.equal(enqueued[0].name, 'Riport.xlsx')
    assert.equal(enqueued[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    const audit: AuditRow[] = []
    const missing = await call(deps({ enqueued, audit, ownExport: null }), { name: 'x', exportId: EXPORT_ID, idempotencyKey: 'k2' }, GOOGLE_DRIVE_UPLOAD_FILE_TOOL)
    assert.equal(payloadOf(missing).code, 'document_export_not_found')
    assert.equal(enqueued.length, 1, 'nothing queued for a foreign or expired file')
    const both = await call(deps({ enqueued, ownExport }), { name: 'x', exportId: EXPORT_ID, textContent: 'y', idempotencyKey: 'k3' }, GOOGLE_DRIVE_UPLOAD_FILE_TOOL)
    assert.equal(payloadOf(both).code, 'invalid_args')
  })

  if (failures > 0) {
    console.error(`document-export: ${failures} failed`)
    process.exit(1)
  }
  console.log('document-export: all passed')
}

void main()
