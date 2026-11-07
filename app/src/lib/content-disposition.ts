/** Fájlnév a fejlécben: ASCII tartalék + UTF-8 (RFC 6266/5987), hogy az ékezet is megmaradjon. */
export function attachmentContentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'dokumentum'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
