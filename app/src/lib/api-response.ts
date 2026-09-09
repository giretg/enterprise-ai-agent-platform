import { NextResponse } from 'next/server'

export function apiOk<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status })
}

export function apiError(message: string, status: number, details?: unknown) {
  return NextResponse.json({ success: false, error: message, details }, { status })
}

/**
 * Alap felső korlát a JSON kérés-törzsekre (1 MiB). A cél az OOM-vektor lezárása:
 * egy hitelesített kliens se küldhessen több MB-os törzset, ami már a `JSON.parse`-nál
 * kimerítené a memória-szűkös Cloud Run konténert. Bőven a legitim törzsméretek fölött
 * (a mező-szintű kapuk 16–64 KiB nagyságrendben vannak), de nagyságrendekkel a
 * katasztrofális törzs alatt. A nagy, változó méretű modell-kontextust hordozó gateway-út
 * ennél tágabb kapot kap (l. a route explicit `maxBytes` argumentuma).
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024

/** Túl nagy kérés-törzs — a hívó 413-ra képezheti le, vagy a meglévő catch-e kezeli. */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`A kérés törzse meghaladja a ${maxBytes} bájtos korlátot`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * A kérés-törzset a bájt-plafonig olvassa, MIELŐTT a memóriába pufferelné és parse-olná.
 * A stream-et darabonként fogyasztja és megszakítja a plafon átlépésekor — így egy óriási
 * (akár chunked, Content-Length nélküli) törzs sem OOM-ol a `JSON.parse` előtt.
 */
async function readBoundedBodyText(request: Request, maxBytes: number): Promise<string> {
  // Gyors út: ha az őszinte Content-Length már túllépi a plafont, elutasítjuk pufferelés nélkül.
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }

  const body = request.body
  if (!body) return request.text()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export async function readJson(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const text = await readBoundedBodyText(request, maxBytes)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON body')
  }
}
