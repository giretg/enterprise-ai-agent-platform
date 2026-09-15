import type { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'

export type LargeToolResultArchiveInput = {
  toolName: string
  callId: string
  turn: number
  content: string
  path?: string
}

function safeToolResultName(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'tool-result'
}

export function createWorkspaceToolResultArchiver(storage: WorkspaceStorage, tenantId: string, scopeId: string) {
  return async (input: LargeToolResultArchiveInput): Promise<{ path: string; bytes: number } | null> => {
    const bytes = Buffer.from(input.content, 'utf8')
    const path =
      input.path ??
      `.tool-results/${String(input.turn + 1).padStart(2, '0')}-${safeToolResultName(input.toolName)}-${safeToolResultName(input.callId)}.json`
    try {
      await storage.write(tenantId, scopeId, path, bytes)
      return { path, bytes: bytes.length }
    } catch {
      return null
    }
  }
}
