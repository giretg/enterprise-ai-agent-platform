/**
 * Méret-kapuzott multipart-olvasás a fájlfeltöltő route-oknak.
 *
 * A natív `request.formData()` a TELJES multipart törzset a memóriába pufferelja,
 * mielőtt a hívó bármit is megnézhetne rajta. A feltöltő route-ok a `file.size`-t
 * csak EZUTÁN ellenőrizték (`> 50 MB → 413`), így a plafon a puffer UTÁN futott:
 * egy több GB-os törzs a memória-szűkös Cloud Run konténerben OOM-ot okozhatott a
 * `file.size` kapu előtt. A `Content-Length` gyors-elutasítás önmagában megkerülhető
 * (chunked / hiányzó hossz), ezért a törzset streamelve is számoljuk, és a plafon
 * átlépésekor a parse-t megszakítjuk — még mielőtt teljesen memóriába kerülne.
 */

/** Pontos per-fájl feltöltés-plafon (üzleti kapu). */
export const WORKSPACE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/**
 * Törzs-szintű OOM-plafon: a fájl-plafon + multipart-keret ráhagyás (határok,
 * part-fejlécek, a kis `path` mező), hogy egy legális 50 MB-os fájlt a törzs-kapu
 * ne utasítson el a pontos per-fájl ellenőrzés előtt.
 */
export const WORKSPACE_MULTIPART_BODY_MAX_BYTES = WORKSPACE_UPLOAD_MAX_BYTES + 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  constructor(message = 'Request body exceeds allowed size') {
    super(message)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * Ugyanaz mint `request.formData()`, de `maxBytes` fölötti törzsnél
 * `RequestBodyTooLargeError`-t dob — a memóriába pufferelés BEFEJEZÉSE előtt.
 * Rossz/nem-multipart törzsnél a natív `formData()` saját hibáját engedi tovább
 * (a hívó ezt 400-ra képezi).
 */
export async function readBoundedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  // Gyors út: ha a kliens bevallja a hosszt és az túl nagy, ne is olvassunk.
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError()
  }

  const body = request.body
  // Nincs törzs (vagy nem streamelhető): a natív formData adja a saját hibáját.
  if (!body) return request.formData()

  let seen = 0
  let exceeded = false
  const bounded = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > maxBytes) {
          exceeded = true
          controller.error(new RequestBodyTooLargeError())
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

  // Új Request a számlált stream-mel; a multipart-határ a Content-Type fejlécből jön,
  // amit változatlanul átviszünk. A `duplex: 'half'` kötelező streamelt törzsnél.
  const gated = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bounded,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

  try {
    return await gated.formData()
  } catch (error) {
    // A stream-megszakítás a formData()-t elutasítja; ezt a saját hibánkra képezzük,
    // hogy a hívó 413-at adhasson. Valódi malformed-multipart hibát tovább engedünk.
    if (exceeded) throw new RequestBodyTooLargeError()
    throw error
  }
}
