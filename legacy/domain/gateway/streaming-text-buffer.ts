/**
 * Közös SSE-delta pufferelés (spec §10.4).
 *
 * A `StreamingSensitiveTextRedactor` és a `StreamingSurrogateResolver` ugyanazt
 * a soft-flush / overlap / hard-buffer / `finish()` ürítési mintát követi:
 * a mintát a delta-határon nem szakítjuk szét, a memória korlátos marad.
 */

export const STREAM_BUFFER_LIMITS = {
  SOFT_FLUSH_CHARS: 512,
  PATTERN_OVERLAP_CHARS: 128,
  HARD_BUFFER_CHARS: 4096,
} as const

export type StreamBufferLimits = typeof STREAM_BUFFER_LIMITS

export type StreamDrainAction =
  | { type: 'emit'; count: number }
  | { type: 'replace'; consume: number; emit: string }
  | { type: 'hold' }

export class StreamingPendingBuffer {
  private pending = ''

  constructor(readonly limits: StreamBufferLimits = STREAM_BUFFER_LIMITS) {}

  get text(): string {
    return this.pending
  }

  get length(): number {
    return this.pending.length
  }

  get isEmpty(): boolean {
    return this.pending.length === 0
  }

  append(delta: string): void {
    if (delta) this.pending += delta
  }

  takePrefix(count: number): string {
    const n = Math.max(0, Math.min(count, this.pending.length))
    const out = this.pending.slice(0, n)
    this.pending = this.pending.slice(n)
    return out
  }

  takeAll(): string {
    const out = this.pending
    this.pending = ''
    return out
  }

  clear(): void {
    this.pending = ''
  }
}

/**
 * Soft-flush vágás: a puffer végén `overlap` karakter marad, hogy egy
 * delta-határon szétszakadó minta a következő drainben még egyben látszódjon.
 * `isSafeCutAfter(index)` akkor igaz, ha az `index` karakter UTÁN szabad vágni.
 */
export function findOverlapFlushCut(
  pending: string,
  isSafeCutAfter: (index: number) => boolean,
  limits: StreamBufferLimits = STREAM_BUFFER_LIMITS,
): number {
  if (pending.length <= limits.SOFT_FLUSH_CHARS) return -1
  const limit = pending.length - limits.PATTERN_OVERLAP_CHARS
  for (let index = limit; index >= 0; index -= 1) {
    if (isSafeCutAfter(index)) return index + 1
  }
  return -1
}

/** A `decide` szerinti ürítés; `finish()`-kor a maradék is kimegy, ha a stratégia benthagyta. */
export function drainStreamingPending(
  buffer: StreamingPendingBuffer,
  final: boolean,
  decide: (pending: string, final: boolean) => StreamDrainAction,
  emit: (chunk: string) => void,
): void {
  while (!buffer.isEmpty) {
    const action = decide(buffer.text, final)
    if (action.type === 'emit') {
      if (action.count <= 0) break
      const chunk = buffer.takePrefix(action.count)
      if (chunk) emit(chunk)
      continue
    }
    if (action.type === 'replace') {
      buffer.takePrefix(action.consume)
      if (action.emit) emit(action.emit)
      continue
    }
    break
  }
  if (final && !buffer.isEmpty) {
    const rest = buffer.takeAll()
    if (rest) emit(rest)
  }
}
