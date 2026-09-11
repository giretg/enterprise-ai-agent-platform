import { NextResponse } from 'next/server'

// Munkaterület-feltöltés felső bájt-plafonja. A `file.size` post-parse PONTOS
// ellenőrzés ezt használja; a Content-Length gyors-elutasítás ezt + a multipart-
// boríték ráhagyást nézi, MIELŐTT a `request.formData()` a teljes törzset memóriába
// pufferelné. Enélkül a méret-kapu csak a teljes törzs kipufferelése UTÁN futna, így
// egy hitelesített kliens tetszőlegesen nagy törzzsel OOM-ot válthatna ki a
// memória-szűkös konténerben (l. Cloud Run OOM incidens).
export const MAX_WORKSPACE_UPLOAD_BYTES = 50 * 1024 * 1024

// Egy helyen származtatott hiba-üzenet, hogy a plafon emelésekor ne maradjon
// elavult „50 MB" szöveg szétszórva a route-okban (a konstansból számolt MiB).
export const WORKSPACE_UPLOAD_LIMIT_MESSAGE = `File exceeds ${Math.round(
  MAX_WORKSPACE_UPLOAD_BYTES / (1024 * 1024),
)} MB limit`

// A multipart-boríték (boundary + rész-fejlécek + `path` mező) néhány száz bájt;
// 1 MiB bőven fedi, így a Content-Length gyors-elutasítás nem ad hamis pozitívat
// egy pont a plafonon lévő, érvényes fájlra.
const MULTIPART_ENVELOPE_SLACK_BYTES = 1024 * 1024

/**
 * Content-Length alapú gyors-elutasítás a `request.formData()` ELŐTT. Ha a bejelentett
 * törzsméret a plafon + boríték fölött van, 413-at ad vissza, így a túlméretes törzs
 * sosem kerül a memóriába. `null`-t ad, ha a kérés továbbengedhető (a Content-Length
 * nélküli / érvénytelen esetet is beleértve — azokra a post-parse `file.size` kapu véd,
 * l. residual: chunked feltöltésnél a pre-buffer plafon nem érvényesül).
 */
export function rejectOversizedUpload(request: Request): NextResponse | null {
  const header = request.headers.get('content-length')
  if (!header) return null
  const declared = Number(header)
  if (!Number.isFinite(declared) || declared < 0) return null
  if (declared > MAX_WORKSPACE_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES) {
    return NextResponse.json(
      { success: false, error: WORKSPACE_UPLOAD_LIMIT_MESSAGE },
      { status: 413 },
    )
  }
  return null
}
