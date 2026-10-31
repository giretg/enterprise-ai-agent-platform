/**
 * #1024: a kész fájlok ideiglenes tárolója és a letöltési döntés.
 * Letöltheti: a kérő user (a saját cégében), vagy a tenant admin, ha a superadmin az admin-betekintést
 * bekapcsolta (#1004 D15). Más user nem tudja meg, hogy a fájl létezik (404); a lejáratot csak a
 * jogosult látja.
 */
export type StoredDocumentExport = {
  id: string
  tenantId: string
  userId: string
  agentId: string
  fileName: string
  format: string
  mimeType: string
  byteSize: number
  createdAt: Date
  expiresAt: Date
}

export interface DocumentExportStore {
  create(input: Omit<StoredDocumentExport, 'id' | 'createdAt'> & { data: Buffer; definitionId: string | null; client: string }): Promise<StoredDocumentExport>
  find(id: string): Promise<StoredDocumentExport | null>
  readData(id: string): Promise<Buffer | null>
  deleteExpired(now: Date): Promise<number>
}

export const DOCUMENT_EXPORT_PATH = '/api/control-plane/document-exports'

export function documentExportPath(id: string): string {
  return `${DOCUMENT_EXPORT_PATH}/${id}`
}

export type ExportViewer = { userId: string; activeTenantId: string | null; role: string | null; adminInsight: boolean }

export type ExportDownloadDecision = { ok: true; asAdmin: boolean } | { ok: false; reason: 'not_found' | 'expired' }

export function decideExportDownload(exp: StoredDocumentExport | null, viewer: ExportViewer, now: Date): ExportDownloadDecision {
  if (!exp || viewer.activeTenantId !== exp.tenantId) return { ok: false, reason: 'not_found' }
  const owner = exp.userId === viewer.userId
  if (!owner && !(viewer.role === 'admin' && viewer.adminInsight)) return { ok: false, reason: 'not_found' }
  if (exp.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true, asAdmin: !owner }
}

/** A Drive-mentéshez (#1024 §2): csak a kérő saját, még élő fájlja. */
export async function loadOwnExport(
  store: DocumentExportStore,
  input: { tenantId: string; userId: string; exportId: string; now: Date },
): Promise<(StoredDocumentExport & { data: Buffer }) | null> {
  const exp = await store.find(input.exportId)
  if (!exp || exp.tenantId !== input.tenantId || exp.userId !== input.userId || exp.expiresAt.getTime() <= input.now.getTime()) return null
  const data = await store.readData(exp.id)
  return data ? { ...exp, data } : null
}
