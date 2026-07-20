/**
 * tulajdoni_lap_parse forrásfeloldás: Document UUID VAGY ticket/chat workspace path.
 *
 * A board ticket feltöltés workspace fájlt ad (path), a chat csatolmány Document UUID-t.
 * Az agent gyakran a fájlnevet adja documentId-nek — azt path-ként kezeljük.
 *
 * Precedencia: érvényes UUID documentId mindig Document-ág (ACL), még ha path is van;
 * különben path / nem-UUID documentId → workspace.
 */

const DOCUMENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** „Majdnem UUID” alak (8 hex + kötőjel…) — ne coerce-oljuk workspace path-ra. */
const LOOKS_LIKE_UUID_RE = /^[0-9a-f]{8}-.+$/i

export function isDocumentUuid(value: string): boolean {
  return DOCUMENT_UUID_RE.test(value.trim())
}

export type TulajdoniLapParseSource =
  | { kind: 'document'; documentId: string }
  | { kind: 'workspace'; path: string }

export function resolveTulajdoniLapParseSource(args: {
  documentId?: string | null
  path?: string | null
}): TulajdoniLapParseSource {
  const documentId = typeof args.documentId === 'string' ? args.documentId.trim() : ''
  const path = typeof args.path === 'string' ? args.path.trim() : ''

  if (documentId && isDocumentUuid(documentId)) {
    return { kind: 'document', documentId }
  }

  if (documentId && LOOKS_LIKE_UUID_RE.test(documentId)) {
    throw new Error(
      `tulajdoni_lap_parse: documentId nem érvényes UUID („${documentId}”). ` +
        `Workspace PDF-hez használd a path paramétert (pl. path: "fajl.pdf").`,
    )
  }

  if (path) {
    return { kind: 'workspace', path }
  }

  if (documentId) {
    // Nem UUID → workspace fájlnév/útvonal (tipikus agent-tévesztés a board feltöltésnél).
    return { kind: 'workspace', path: documentId }
  }

  throw new Error(
    'tulajdoni_lap_parse: add meg a documentId-t (UUID csatolmány) vagy a path-ot (ticket/chat workspace PDF, pl. "043_15 2026.07.16.pdf")',
  )
}
