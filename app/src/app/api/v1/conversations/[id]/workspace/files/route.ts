import { NextResponse } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'
import { FileEditorError } from '@/domain/file-editor/workspace-storage'
import { resolveWorkspaceTenantKey } from '@/lib/workspace-resource-access'
import { isHtmlWorkspaceFile } from '@/lib/workspace-file-visibility'

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

function getStorage() {
  return new WorkspaceStorage(process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod')
}

async function resolveConversation(conversationId: string, tenantId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, tenantId: true, agentId: true, createdById: true },
  })
}

// GET /api/v1/conversations/[id]/workspace/files
// ?path=filename → stream file as download
// ?path=filename&disposition=inline → izolált HTML-megnyitás
// ?path=filename&signed=1 → pre-signed download URL (15 min)
// (no path) → list workspace files
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireTenantRole('viewer').catch(() => null)
  if (!user) return jsonError('Unauthorized', 401)

  const { id: conversationId } = await params
  const conversation = await resolveConversation(conversationId, user.activeTenantId)
  if (!conversation) return jsonError('Conversation not found', 404)
  let tenantId: string
  try {
    tenantId = resolveWorkspaceTenantKey(conversation, user.activeTenantId)
  } catch {
    return jsonError('Conversation not found', 404)
  }

  const url = new URL(request.url)
  const filePath = url.searchParams.get('path')
  const signed = url.searchParams.get('signed') === '1'
  const inline = url.searchParams.get('disposition') === 'inline'

  const storage = getStorage()

  try {
    if (filePath) {
      if (inline && !isHtmlWorkspaceFile(filePath)) {
        return jsonError('Only HTML workspace files can be opened inline', 400)
      }
      if (signed) {
        const signedUrl = await storage.getSignedDownloadUrl(tenantId, conversationId, filePath, {
          stubDownloadPath: `/api/v1/conversations/${conversationId}/workspace/files`,
        })
        return NextResponse.json({
          success: true,
          data: { url: signedUrl.url, expiresAt: signedUrl.expiresAt.toISOString() },
        })
      }

      const result = await storage.streamToClient(tenantId, conversationId, filePath)
      if (!result) return jsonError('File not found', 404)
      const filename = filePath.split('/').pop() ?? filePath
      return new NextResponse(result.stream, {
        headers: {
          'content-type': inline ? 'text/html; charset=utf-8' : result.contentType,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`,
          ...(inline
            ? {
                // Az agent által készített HTML ugyanazon az originen érkezik:
                // izoláljuk, hogy ne tudjon scriptet futtatni vagy a platformhoz hozzáférni.
                'content-security-policy': "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'",
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
              }
            : {}),
          ...(result.size > 0 ? { 'content-length': String(result.size) } : {}),
        },
      })
    }

    const files = await storage.listUserFacing(tenantId, conversationId)
    return NextResponse.json({ success: true, data: { files } })
  } catch (e) {
    if (e instanceof FileEditorError) return jsonError(e.message, 400)
    return jsonError(e instanceof Error ? e.message : 'Storage error', 500)
  }
}

// POST /api/v1/conversations/[id]/workspace/files
// multipart form: file field + optional path field
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireTenantRole('operator').catch(() => null)
  if (!user) return jsonError('Unauthorized', 401)

  const { id: conversationId } = await params
  const conversation = await resolveConversation(conversationId, user.activeTenantId)
  if (!conversation) return jsonError('Conversation not found', 404)
  let tenantId: string
  try {
    tenantId = resolveWorkspaceTenantKey(conversation, user.activeTenantId)
  } catch {
    return jsonError('Conversation not found', 404)
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return jsonError('Expected multipart/form-data', 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return jsonError('Missing "file" field', 400)

  const pathField = formData.get('path')
  const filePath = typeof pathField === 'string' && pathField.trim() ? pathField.trim() : file.name

  const MAX = 50 * 1024 * 1024
  if (file.size > MAX) return jsonError('File exceeds 50 MB limit', 413)

  const storage = getStorage()

  try {
    const buf = Buffer.from(await file.arrayBuffer())
    await storage.write(tenantId, conversationId, filePath, buf)
    await storage.setFileAudience(tenantId, conversationId, filePath, 'user')
    return NextResponse.json({ success: true, data: { path: filePath, bytesWritten: buf.length } })
  } catch (e) {
    if (e instanceof FileEditorError) {
      const status = e.code === 'WORKSPACE_TOO_LARGE' ? 413 : 400
      return jsonError(e.message, status)
    }
    return jsonError(e instanceof Error ? e.message : 'Upload failed', 500)
  }
}
