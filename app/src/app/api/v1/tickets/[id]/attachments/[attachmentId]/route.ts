import { NextResponse } from 'next/server'

import { requireTenantRole } from '@/auth/tenant-context'
import { loadTicketInputAttachmentDownload } from '@/domain/ticket/ticket-input-attachment-service'

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const user = await requireTenantRole('viewer').catch(() => null)
  if (!user) return jsonError('Unauthorized', 401)

  const { id: ticketId, attachmentId } = await params
  const download = await loadTicketInputAttachmentDownload({
    ticketId,
    attachmentId,
    tenantId: user.activeTenantId,
  })
  if (!download) return jsonError('Attachment not found', 404)

  return new NextResponse(new Uint8Array(download.bytes), {
    headers: {
      'content-type': download.contentType,
      'content-length': String(download.bytes.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
      'x-original-file-available': download.originalAvailable ? 'true' : 'false',
    },
  })
}
