/**
 * Office Open XML (docx/xlsx/pptx) letöltési feloldás.
 *
 * Ugyanaz a szabály, mint a workspace HTML-nél / mini-appnél: a tárban az
 * artifact tokenizált marad; csak a nézőnek szánt válasz oldja fel az
 * álneveket az XML szöveg-node-okban (export_report mátrix).
 */
import JSZip from 'jszip'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import {
  resolveEgressTextForSurface,
  type EgressResolveAudit,
} from '@/domain/privacy/resolve-display-text'
import type { ResolvedPrivacyEgressMatrix } from '@/domain/privacy/privacy-egress-matrix'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { containsEmbeddedSurrogate } from '@/domain/privacy/surrogate-format'

const XML_PART = /\.(xml|rels)$/i

export async function resolveOfficeFileEgressForViewer(params: {
  buffer: Buffer
  engine: SurrogateEngine | null | undefined
  tenantId: string | null | undefined
  conversationId?: string | null
  ticketId?: string | null
  requesterUserId?: string | null
  surface: 'web_ui' | 'export_report'
  matrix?: ResolvedPrivacyEgressMatrix
  onResolved?: EgressResolveAudit
}): Promise<Buffer> {
  const buffer = params.buffer
  if (!buffer.length || !params.engine || !params.tenantId || !params.requesterUserId) {
    return buffer
  }
  const scope = privacyScopeForCall(params.conversationId, params.ticketId)
  if (!scope) return buffer

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return buffer
  }

  let changed = false
  const names = Object.keys(zip.files)
  for (const name of names) {
    const entry = zip.files[name]
    if (!entry || entry.dir || !XML_PART.test(name)) continue
    const xml = await entry.async('string')
    if (!containsEmbeddedSurrogate(xml)) continue
    const resolved = await resolveEgressTextForSurface({
      text: xml,
      surface: params.surface,
      engine: params.engine,
      tenantId: params.tenantId,
      scope,
      requesterUserId: params.requesterUserId,
      matrix: params.matrix,
      contentKind: 'html',
      onResolved: params.onResolved,
    })
    if (resolved !== xml) {
      zip.file(name, resolved)
      changed = true
    }
  }

  if (!changed) return buffer
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  return Buffer.from(out)
}
