/**
 * Kötött kérés-törzs olvasó az önhitelesített ingress-route-okhoz.
 *
 * Üzleti indok: a Model Gateway memóriaszűkös Cloud Run konténerben fut, és egy
 * instance több bérlőt szolgál ki. Egy határ nélkül beolvasott törzs már a
 * `JSON.parse` előtt elfogyaszthatja a memóriát (OOM) — ilyenkor a konténer
 * minden bérlő kérését elejti, nem csak a támadóét. Ez a helper a törzset a
 * bájt-plafonig olvassa, és streamelve megszakít, mielőtt pufferelné; így a
 * hiányzó vagy hazudott `Content-Length` (chunked) törzs is korlátos marad.
 *
 * Rokon a `model-gateway` proxy (`MAX_REQUEST_BYTES`) és az `ai-audit/events`
 * (`MAX_BATCH_BYTES`) saját, soron belüli kapujával; azok ma `request.text()`-tel
 * előbb pufferelnek, és karakterhosszt (UTF-16) néznek — ez a helper bájtban
 * számol ÉS streamelve szakít meg, ezért a chunked (CL nélküli/hazudott) törzs
 * ellen is zár. A testvér-route-ok erre a helperre terelése külön, követő munka.
 */

/** A törzs túllépte a megengedett bájt-plafont (→ a hívó 413-at adjon). */
export class RequestTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'RequestTooLargeError'
  }
}

/**
 * A kérés törzsét szövegként adja vissza, legfeljebb `maxBytes` bájtig.
 * `RequestTooLargeError`, ha a `Content-Length` vagy a ténylegesen beolvasott
 * bájtszám átlépi a plafont.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestTooLargeError()

  const reader = request.body?.getReader()
  if (!reader) {
    // Nincs olvasható stream (pl. teszt-dupla): az egyben beolvasott törzset is kapuzzuk.
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new RequestTooLargeError()
    return text
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RequestTooLargeError()
    }
    chunks.push(value)
  }
  const merged = Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
    total,
  )
  return merged.toString('utf8')
}

/**
 * A kérés törzsét JSON-ként adja vissza, legfeljebb `maxBytes` bájtig.
 * `RequestTooLargeError` túl nagy törzsnél; `SyntaxError` érvénytelen JSON-nál
 * (a hívó a kettőt 413 vs. 400 felé képezi). Üres törzs → `null`.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes)
  if (!text.trim()) return null
  return JSON.parse(text) as unknown
}
