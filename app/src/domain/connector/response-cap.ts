/**
 * `fetch` válasz-törzs olvasása KEMÉNY bájt-plafonnal.
 *
 * A `res.text()` a teljes választ egyetlen stringbe húzza, mérettől függetlenül. Egy
 * connector tetszőleges külső hostra mutathat (generikus http_api motor, NAV, Számlázz),
 * és a válasz-törzs mérete a platform kontrollján kívül esik: egy hibás vagy rosszindulatú
 * upstream több gigabájtos (Content-Length nélküli, chunked) törzzsel OOM-ot okozhat a
 * közös, több-bérlős Cloud Run példányon — ami minden ott futó bérlő hívását megakasztja.
 *
 * Ez az olvasó a stream olvasását a plafon átlépésekor leállítja és a streamet lezárja,
 * így a memóriahasználat kötött marad. A `maxResponseChars` (modell-kontextus) csonkolás
 * CSAK ezután, a már kötött méretű szövegen fut.
 */
export async function readResponseTextCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body
  if (!body) return { text: '', truncated: false }

  const reader = body.getReader()
  const chunks: Buffer[] = []
  let kept = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const remaining = maxBytes - kept
      if (value.byteLength > remaining) {
        // Csak a plafonig tartó részt tartjuk meg, a többit eldobjuk és a streamet lezárjuk.
        if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining))
        truncated = true
        break
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      kept += value.byteLength
    }
  } finally {
    // A fennmaradó törzs eldobása: felszabadítja a kapcsolatot, nem olvas tovább a memóriába.
    await reader.cancel().catch(() => {})
  }
  // A bájt-határon történő vágás kettévághat egy több-bájtos UTF-8 karaktert; a TextDecoder
  // (nem-fatal) a csonka záró bájtokat U+FFFD-re cseréli — csonkolt előnézetnél/hibánál rendben.
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated }
}
