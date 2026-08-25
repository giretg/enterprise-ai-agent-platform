/**
 * Folyamat-lépés workspace-handoff: a ticket-szintű tár prefixe miatt a következő
 * lépés a saját ticketje alatt keresi a fájlt. Ez a modul a path-heurisztikát,
 * a bináris másolást és a kötelező path fail-closed kapuját adja — DB nélkül.
 */
import type { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
const EMAIL_ADDRESS = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/
const WORKSPACE_PATH_SLOT = /(path|file|artifact|document|attachment)$/i

declare const workspaceRelativePathBrand: unique symbol
export type WorkspaceRelativePath = string & {
  readonly [workspaceRelativePathBrand]: true
}

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

function parseWorkspaceRelativePath(value: string): WorkspaceRelativePath | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isUrl(trimmed) || isAbsolutePath(trimmed) || EMAIL_ADDRESS.test(trimmed)) return null
  const withSlashes = trimmed.replace(/\\/g, '/')
  const parts = withSlashes.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..')) return null
  return parts.join('/') as WorkspaceRelativePath
}

function looksLikeWorkspaceRelativePath(normalized: string): boolean {
  if (FILE_EXTENSION.test(normalized)) return true
  return normalized.includes('/')
}

/**
 * Determinisztikus, DB nélkül: mely string értékek workspace-relatív path jelöltek.
 * Csak top-level stringek; abszolút path, URL és `..` traversal kiesik.
 */
export function collectHandoffCandidatePaths(
  values: Record<string, unknown>,
): WorkspaceRelativePath[] {
  const seen = new Set<WorkspaceRelativePath>()
  const out: WorkspaceRelativePath[] = []
  for (const value of Object.values(values)) {
    if (typeof value !== 'string') continue
    const normalized = parseWorkspaceRelativePath(value)
    if (!normalized || !looksLikeWorkspaceRelativePath(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * A fail-closed kapu csak explicit path/artifact nevű kontraktusmezőkre vonatkozik.
 * Így egy e-mail, verziószám vagy helyrajzi szám nem válik pusztán a string
 * alakja miatt kötelező workspace-fájllá.
 */
export function collectRequiredHandoffPaths(
  values: Record<string, unknown>,
): WorkspaceRelativePath[] {
  return collectHandoffCandidatePaths(
    Object.fromEntries(Object.entries(values).filter(([name]) => WORKSPACE_PATH_SLOT.test(name))),
  )
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
