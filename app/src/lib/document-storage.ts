import type { Prisma } from '@prisma/client'

const PDF_HEADER = Buffer.from('%PDF-')
const ZIP_HEADER = Buffer.from([0x50, 0x4b])
export const DOCUMENT_STORAGE_FORMAT_ORIGINAL = 'original' as const

export function buildOriginalDocumentMetadata(
  byteSize: number,
  extra: Prisma.JsonObject = {},
): Prisma.JsonObject {
  return {
    ...extra,
    storageFormat: DOCUMENT_STORAGE_FORMAT_ORIGINAL,
    byteSize,
  }
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix)
}

function originalBinaryAvailable(bytes: Buffer, filename: string, mimeType: string | null): boolean {
  const lower = filename.toLowerCase()
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return startsWith(bytes, PDF_HEADER)
  if (/\.(docx|xlsx|xlsm|pptx)$/i.test(lower)) return startsWith(bytes, ZIP_HEADER)
  if (mimeType?.startsWith('image/')) {
    return (
      startsWith(bytes, Buffer.from([0xff, 0xd8, 0xff])) ||
      startsWith(bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      startsWith(bytes, Buffer.from('GIF8')) ||
      (bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    )
  }
  return true
}

export function resolveStoredDocumentDownload(input: {
  bytes: Buffer
  filename: string
  mimeType: string | null
}): {
  bytes: Buffer
  filename: string
  contentType: string
  originalAvailable: boolean
} {
  const originalAvailable = originalBinaryAvailable(input.bytes, input.filename, input.mimeType)
  if (!originalAvailable) {
    return {
      bytes: input.bytes,
      filename: `${input.filename}.txt`,
      contentType: 'text/plain; charset=utf-8',
      originalAvailable: false,
    }
  }
  return {
    bytes: input.bytes,
    filename: input.filename,
    contentType: input.mimeType || 'application/octet-stream',
    originalAvailable: true,
  }
}
