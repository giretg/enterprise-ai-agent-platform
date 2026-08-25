/**
 * Folyamat-lépés workspace-handoff: a ticket-szintű tár prefixe miatt a következő
 * lépés a saját ticketje alatt keresi a fájlt. Ez a modul a path-heurisztikát,
 * a bináris másolást és a kötelező path fail-closed kapuját adja — DB nélkül.
 */
import type { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

export class HandoffFileMissingError extends Error {
  constructor(
    readonly missingPaths: string[],
    readonly ticketId: string,
  ) {
    super(
      `Hiányzó workspace-handoff fájl(ok) a(z) '${ticketId}' ticketen: ${missingPaths.join(', ')}`,
    )
    this.name = 'HandoffFileMissingError'
  }
}

function isAbsolutePath(value: string): boolean {
  if (WINDOWS_ABSOLUTE.test(value)) return true
  if (value.startsWith('/') || value.startsWith('\\')) return true
  return false
}

function isUrl(value: string): boolean {
  if (WINDOWS_ABSOLUTE.test(value)) return false
  return URL_SCHEME.test(value)
}

function normalizeHandoffPath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isUrl(trimmed) || isAbsolutePath(trimmed)) return null
  const withSlashes = trimmed.replace(/\\/g, '/')
  const parts = withSlashes.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..')) return null
  return parts.join('/')
}

function looksLikeWorkspaceRelativePath(normalized: string): boolean {
  if (FILE_EXTENSION.test(normalized)) return true
  // `/` önmagában nem elég: hrsz (`043/15`) és magyar cím (`Külterület, 43/15…`)
  // nem workspace-fájl. Csak whitespace nélküli, betűt is tartalmazó relatív path.
  if (!normalized.includes('/') || /\s/.test(normalized)) return false
  return normalized.split('/').some((part) => /[A-Za-z]/.test(part))
}

/**
 * Determinisztikus, DB nélkül: mely string értékek workspace-relatív path jelöltek.
 * Csak top-level stringek; abszolút path, URL és `..` traversal kiesik.
 */
export function collectHandoffCandidatePaths(values: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of Object.values(values)) {
    if (typeof value !== 'string') continue
    const normalized = normalizeHandoffPath(value)
    if (!normalized || !looksLikeWorkspaceRelativePath(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export async function copyWorkspaceHandoff(input: {
  storage: WorkspaceStorage
  tenantId: string
  fromTicketId: string
  toTicketId: string
  paths: string[]
}): Promise<{ copied: string[]; missing: string[] }> {
  const copied: string[] = []
  const missing: string[] = []
  for (const filePath of input.paths) {
    const bytes = await input.storage.read(input.tenantId, input.fromTicketId, filePath)
    if (!bytes) {
      missing.push(filePath)
      continue
    }
    await input.storage.write(input.tenantId, input.toTicketId, filePath, bytes)
    const audience = await input.storage.getFileAudience(
      input.tenantId,
      input.fromTicketId,
      filePath,
    )
    if (audience) {
      await input.storage.setFileAudience(
        input.tenantId,
        input.toTicketId,
        filePath,
        audience,
      )
    }
    copied.push(filePath)
  }
  return { copied, missing }
}

/** Fail-closed kapu a következő lépés kötelező path-slotjaira a cél-ticketen. */
export async function assertRequiredHandoffFilesPresent(input: {
  storage: WorkspaceStorage
  tenantId: string
  ticketId: string
  requiredPaths: string[]
}): Promise<void> {
  const missing: string[] = []
  for (const filePath of input.requiredPaths) {
    const bytes = await input.storage.read(input.tenantId, input.ticketId, filePath)
    if (!bytes) missing.push(filePath)
  }
  if (missing.length > 0) {
    throw new HandoffFileMissingError(missing, input.ticketId)
  }
}
