/**
 * Streaming megjelenítési feloldás (APG-06, spec §10.4).
 *
 * Az álnév karakterei SSE-delták között szétszakadhatnak (`[[COMP` | `ANY_1]]`).
 * A feloldó a közös `StreamingPendingBuffer` mintáját követi: a `[[` nyitótól
 * a záró `]]`-ig visszatartás, korlátos puffer, `finish()` ürítés. Töredék
 * álnév (`[[COMP`) soha nem megy ki. A feloldás a teljes eddigi markdown
 * kontextusában történik (APG-07): URL/kód darabjai nem oldódnak fel.
 */
import {
  STREAM_BUFFER_LIMITS,
  StreamingPendingBuffer,
  drainStreamingPending,
  type StreamDrainAction,
} from '@/domain/gateway/streaming-text-buffer'
import {
  createWebUiDisplayLookup,
  resolveDisplayText,
  type SurrogateDisplayLookup,
} from '@/domain/privacy/resolve-display-text'
import { isSurrogatePrefix } from '@/domain/privacy/surrogate-format'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export class StreamingSurrogateResolver {
  private readonly buffer = new StreamingPendingBuffer()
  private finished = false
  /** Az eddig kiadott eredeti (álneves) markdown — a darab önmagában nem osztályozható. */
  private originalEmitted = ''

  constructor(
    private readonly lookup: SurrogateDisplayLookup,
    private readonly emit: (text: string) => void | Promise<void>,
  ) {}

  get isEmpty(): boolean {
    return this.buffer.isEmpty
  }

  async push(delta: string): Promise<void> {
    if (!delta || this.finished) return
    this.buffer.append(delta)
    await this.flush(false)
  }

  async finish(): Promise<void> {
    if (this.finished) return
    await this.flush(true)
    this.finished = true
  }

  private async flush(final: boolean): Promise<void> {
    const released: string[] = []
    drainStreamingPending(this.buffer, final, (pending, isFinal) => decide(pending, isFinal), (chunk) =>
      released.push(chunk),
    )
    for (const chunk of released) {
      const originalSoFar = this.originalEmitted + chunk
      const resolved = await resolveDisplayText(chunk, this.lookup, originalSoFar)
      this.originalEmitted = originalSoFar
      if (resolved) await this.emit(resolved)
    }
  }
}

export function createWebUiStreamingResolver(params: {
  engine: SurrogateEngine | null | undefined
  tenantId: string | null | undefined
  conversationId: string
  requesterUserId?: string | null
  emit: (text: string) => void | Promise<void>
}): StreamingSurrogateResolver {
  const lookup: SurrogateDisplayLookup =
    params.engine && params.tenantId
      ? createWebUiDisplayLookup({
          engine: params.engine,
          tenantId: params.tenantId,
          scope: { type: 'conversation', id: params.conversationId } satisfies PrivacyScope,
          requesterUserId: params.requesterUserId,
        })
      : async () => null
  return new StreamingSurrogateResolver(lookup, params.emit)
}

function decide(pending: string, final: boolean): StreamDrainAction {
  const open = pending.indexOf('[[')
  if (open < 0) {
    if (!final && pending.endsWith('[')) {
      return pending.length > 1 ? { type: 'emit', count: pending.length - 1 } : { type: 'hold' }
    }
    return { type: 'emit', count: pending.length }
  }
  if (open > 0) return { type: 'emit', count: open }

  const close = pending.indexOf(']]', 2)
  if (close >= 0) return { type: 'emit', count: close + 2 }

  if (final) return { type: 'replace', consume: pending.length, emit: '' }

  if (!isSurrogatePrefix(pending)) return { type: 'emit', count: 2 }

  if (pending.length > STREAM_BUFFER_LIMITS.HARD_BUFFER_CHARS) {
    return { type: 'emit', count: 2 }
  }
  return { type: 'hold' }
}
