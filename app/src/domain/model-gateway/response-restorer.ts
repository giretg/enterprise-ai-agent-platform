/**
 * Álnév-visszaállítás a Hermesnek visszaadott válaszban (#746 V1-4): a szövegben és a modell tool-hívásainak
 * argumentumaiban (így a helyi és az MCP toolok valódi értéket kapnak). Működik nem-stream JSON-ra és SSE-re;
 * a streamben az SSE-deltákra szakadt álnevet (`[[EMA` | `IL_1]]`) visszatartja, amíg eldönthető.
 */
import { isSurrogatePrefix } from '@/domain/privacy/surrogate-format'
import type { SurrogateSession } from '@/domain/model-gateway/content-filter'

/** Az álnév-prefix hossza nem haladhatja meg ezt; ennél hosszabb „[[…” már biztosan nem álnév. */
const MAX_HOLD = 64
const TEXT_FIELDS = ['content', 'reasoning', 'reasoning_content'] as const

/** Hol kezdődik a lezáratlan álnév-prefix a szöveg végén (a szöveg hossza, ha nincs). */
function holdIndex(text: string): number {
  const open = text.lastIndexOf('[[')
  if (open >= 0 && text.length - open <= MAX_HOLD && isSurrogatePrefix(text.slice(open))) return open
  return text.endsWith('[') ? text.length - 1 : text.length
}

class Restorer {
  private held = ''
  constructor(
    private session: SurrogateSession,
    private jsonEscape: boolean,
  ) {}

  push(delta: string): string {
    const text = this.held + delta
    const from = holdIndex(text)
    this.held = text.slice(from)
    return this.session.restore(text.slice(0, from), this.jsonEscape)
  }

  flush(): string {
    const text = this.held
    this.held = ''
    return this.session.restore(text, this.jsonEscape)
  }
}

type Choice = {
  index?: number
  finish_reason?: string | null
  message?: Record<string, unknown>
  delta?: {
    tool_calls?: Array<{ index?: number; function?: { arguments?: string } }>
  } & Record<string, unknown>
}
type Payload = { id?: string; model?: string; created?: number; choices?: Choice[] }

function restoreMessage(message: Record<string, unknown>, session: SurrogateSession): void {
  for (const field of TEXT_FIELDS) if (typeof message[field] === 'string') message[field] = session.restore(message[field])
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return
  for (const call of calls as Array<{ function?: { arguments?: unknown } }>) {
    if (typeof call?.function?.arguments === 'string') call.function.arguments = session.restore(call.function.arguments, true)
  }
}

/**
 * Hiba esetén (a vault nem tölthető be) a válasz érintetlenül megy tovább: álnevekkel olvasható,
 * de nem szivárog semmi — a szűrő már a kérésnél fail-closed volt.
 */
export function createRestoreTransform(opts: {
  stream: boolean
  session: () => Promise<SurrogateSession>
}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let session: SurrogateSession | null | undefined

  const load = async () => {
    if (session === undefined) session = await opts.session().catch(() => null)
    return session
  }

  // --- nem-stream: a teljes JSON-t egyben ---
  if (!opts.stream) {
    let raw = ''
    return new TransformStream({
      transform(chunk) {
        raw += decoder.decode(chunk, { stream: true })
      },
      async flush(controller) {
        raw += decoder.decode()
        const s = await load()
        let out = raw
        if (s) {
          try {
            const data = JSON.parse(raw) as Payload
            for (const choice of data.choices ?? []) if (choice.message) restoreMessage(choice.message, s)
            out = JSON.stringify(data)
          } catch {
            // nem JSON: érintetlenül tovább
          }
        }
        controller.enqueue(encoder.encode(out))
      },
    })
  }

  // --- stream: soronként, choice × mező szerinti visszatartó pufferekkel ---
  const restorers = new Map<string, Restorer>()
  const restorerFor = (key: string, s: SurrogateSession, jsonEscape: boolean) => {
    let r = restorers.get(key)
    if (!r) restorers.set(key, (r = new Restorer(s, jsonEscape)))
    return r
  }
  let pending = ''
  let last: Payload = {}

  /** Egy choice visszatartott maradéka (csak lezáratlan „[[…” lehet), a pufferek ürítésével. */
  const takeHeld = (choiceIndex: number) => {
    const fields: Array<[string, string]> = []
    for (const field of TEXT_FIELDS) {
      const held = restorers.get(`${choiceIndex}:${field}`)?.flush()
      if (held) fields.push([field, held])
    }
    const calls: Array<{ index: number; function: { arguments: string } }> = []
    for (const [key, restorer] of restorers) {
      if (!key.startsWith(`${choiceIndex}:tc`)) continue
      const held = restorer.flush()
      if (held) calls.push({ index: Number(key.slice(`${choiceIndex}:tc`.length)), function: { arguments: held } })
    }
    return { fields, calls }
  }

  /** Lezáratlan maradék külön chunkban — [DONE] előtt vagy megszakadt streamnél. */
  const flushChunk = (choiceIndex: number): string => {
    const { fields, calls } = takeHeld(choiceIndex)
    if (!fields.length && !calls.length) return ''
    const delta = { ...Object.fromEntries(fields), ...(calls.length ? { tool_calls: calls } : {}) }
    const chunk = { id: last.id, model: last.model, created: last.created, object: 'chat.completion.chunk', choices: [{ index: choiceIndex, delta, finish_reason: null }] }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  const processLine = async (line: string): Promise<string> => {
    const trimmed = line.trim()
    const s = trimmed.startsWith('data:') ? await load() : null
    if (!s) return `${line}\n`
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') {
      return [...new Set([...restorers.keys()].map((k) => Number(k.split(':')[0])))].map(flushChunk).join('') + `${line}\n`
    }
    let payload: Payload
    try {
      payload = JSON.parse(data)
    } catch {
      return `${line}\n`
    }
    last = { id: payload.id ?? last.id, model: payload.model ?? last.model, created: payload.created ?? last.created }
    for (const choice of payload.choices ?? []) {
      const index = choice.index ?? 0
      const delta = choice.delta
      if (!delta) continue
      for (const field of TEXT_FIELDS) {
        if (typeof delta[field] === 'string') delta[field] = restorerFor(`${index}:${field}`, s, false).push(delta[field] as string)
      }
      for (const call of delta.tool_calls ?? []) {
        if (typeof call.function?.arguments === 'string') {
          call.function.arguments = restorerFor(`${index}:tc${call.index ?? 0}`, s, true).push(call.function.arguments)
        }
      }
      if (choice.finish_reason) {
        // A maradék a lezáró chunk saját deltájához fűződik, így a sorrend megmarad.
        const { fields, calls } = takeHeld(index)
        for (const [field, held] of fields) delta[field] = `${typeof delta[field] === 'string' ? delta[field] : ''}${held}`
        for (const held of calls) {
          const own = delta.tool_calls?.find((c) => (c.index ?? 0) === held.index)
          if (own) own.function = { arguments: `${own.function?.arguments ?? ''}${held.function.arguments}` }
          else (delta.tool_calls ??= []).push(held)
        }
      }
    }
    return `data: ${JSON.stringify(payload)}\n`
  }

  const drain = async (final: boolean): Promise<string> => {
    const lines = pending.split('\n')
    pending = final ? '' : (lines.pop() ?? '')
    let out = ''
    for (const line of final && lines.length === 1 && !lines[0] ? [] : lines) out += await processLine(line.replace(/\r$/, ''))
    return out
  }

  return new TransformStream({
    async transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const out = await drain(false)
      if (out) controller.enqueue(encoder.encode(out))
    },
    async flush(controller) {
      pending += decoder.decode()
      let out = await drain(true)
      // Ha nem jött [DONE]/finish_reason (megszakadt stream), a visszatartott maradék akkor is kimegy.
      for (const index of new Set([...restorers.keys()].map((k) => Number(k.split(':')[0])))) out += flushChunk(index)
      if (out) controller.enqueue(encoder.encode(out))
    },
  })
}
