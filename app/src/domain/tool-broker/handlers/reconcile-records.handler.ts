import { FileEditorError } from '@/domain/file-editor/file-editor-service'
import {
  buildReconcileSummaryForModel,
  parseReconcileRecordList,
  reconcileRecords,
  type ReconcileCompareField,
  type ReconcileNormalize,
} from '@/lib/reconcile-records'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const NORMALIZE_MODES = new Set<ReconcileNormalize>(['trim', 'lower', 'hu-name', 'year'])

function asNormalizeMap(value: unknown): Record<string, ReconcileNormalize> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, ReconcileNormalize> = {}
  for (const [key, mode] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mode === 'string' && NORMALIZE_MODES.has(mode as ReconcileNormalize)) {
      out[key] = mode as ReconcileNormalize
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function asCompareFields(value: unknown): ReconcileCompareField[] {
  if (!Array.isArray(value)) return []
  const out: ReconcileCompareField[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ field: item.trim(), mode: 'exact' })
      continue
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const field = typeof row.field === 'string' ? row.field.trim() : ''
    if (!field) continue
    const mode =
      row.mode === 'number' || row.mode === 'fraction' || row.mode === 'exact' ? row.mode : 'exact'
    const epsilon = typeof row.epsilon === 'number' && Number.isFinite(row.epsilon) ? row.epsilon : undefined
    out.push({ field, mode, epsilon })
  }
  return out
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
}

async function readRecordList(
  fe: ToolHandlerArgs['ctx']['fileEditor'],
  tenantId: string,
  workspaceId: string,
  path: string,
): Promise<Record<string, unknown>[]> {
  // Nyers szöveg kell — a readFile sortáblázott (1\t…) kimenete NEM érvényes JSON.
  const content = await fe.readTextFileOrNull(tenantId, workspaceId, { path })
  if (content == null) {
    throw new Error(`reconcile_records: a(z) "${path}" fájl nem található`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`reconcile_records: a(z) "${path}" fájl nem érvényes JSON`)
  }
  const rows = parseReconcileRecordList(parsed)
  if (!rows) {
    throw new Error(
      `reconcile_records: a(z) "${path}" fájl nem tömb és nincs benne rows/sorok/items/data/records tömb`,
    )
  }
  return rows
}

/**
 * reconcile_records — két workspace JSON-lista determinisztikus egyeztetése
 * (issue #179 WP-2). A teljes egyesített lista fájlba kerül; a modell csak
 * összegzést + bizonytalan párokat kap.
 */
export const reconcileRecordsHandler: ToolHandler = {
  id: 'reconcile_records',
  handles(tool) {
    return tool === 'reconcile_records'
  },
  async execute({ ctx, input, authorization, actingTenantId }: ToolHandlerArgs) {
    if (input.tool !== 'reconcile_records') {
      throw new Error(`reconcile_records handler received ${input.tool}`)
    }
    const connector = authorization.connector
    if (!connector) throw new Error('reconcile_records requires workspace connector authorization')

    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('reconcile_records requires ticketId or conversationId')

    const tenantId = await ctx.resolveWorkspaceStorageTenantId(
      input,
      actingTenantId,
      connector.tenantId,
    )
    const fe = ctx.fileEditor
    const args = input.args
    const keyFields = asStringList(args.keyFields)
    if (keyFields.length === 0) {
      throw new Error('reconcile_records: keyFields kötelező (legalább egy mező)')
    }
    if (!args.leftPath?.trim() || !args.rightPath?.trim() || !args.outputPath?.trim()) {
      throw new Error('reconcile_records: leftPath, rightPath és outputPath kötelező')
    }

    try {
      const left = await readRecordList(fe, tenantId, workspaceId, args.leftPath.trim())
      const right = await readRecordList(fe, tenantId, workspaceId, args.rightPath.trim())
      const compareFields = asCompareFields(args.compareFields)
      // numberTolerances shorthand → compareFields epsilon
      if (args.numberTolerances && typeof args.numberTolerances === 'object') {
        for (const [field, epsilon] of Object.entries(args.numberTolerances)) {
          if (typeof epsilon !== 'number' || !Number.isFinite(epsilon)) continue
          const existing = compareFields.find((c) => c.field === field)
          if (existing) {
            existing.mode = existing.mode ?? 'number'
            existing.epsilon = epsilon
          } else {
            compareFields.push({ field, mode: 'number', epsilon })
          }
        }
      }
      for (const field of asStringList(args.fractionFields)) {
        if (!compareFields.some((c) => c.field === field)) {
          compareFields.push({ field, mode: 'fraction' })
        }
      }

      const result = reconcileRecords({
        left,
        right,
        keyFields,
        normalize: asNormalizeMap(args.normalize),
        compareFields,
      })

      const outputPath = args.outputPath.trim()
      const payload = `${JSON.stringify(
        {
          summary: result.summary,
          rows: result.rows,
          uncertain: result.uncertain,
        },
        null,
        2,
      )}\n`
      await fe.writeFile(tenantId, workspaceId, { path: outputPath, content: payload })

      const text = buildReconcileSummaryForModel(result, {
        outputPath,
        identityFields: keyFields,
      })

      return {
        ok: true,
        outputPath,
        summary: result.summary,
        uncertainCount: result.uncertain.length,
        // A modellnek szánt tömör szöveg — a broker JSON-ként is elviszi.
        message: text,
        uncertain: result.uncertain.slice(0, 8).map((u) => ({
          note: u.note,
          left: Object.fromEntries(keyFields.map((f) => [f, u.left[f]])),
          right: Object.fromEntries(keyFields.map((f) => [f, u.right[f]])),
        })),
      }
    } catch (error) {
      if (error instanceof FileEditorError) {
        throw new Error(`${error.code}: ${error.message}`)
      }
      throw error
    }
  },
}
