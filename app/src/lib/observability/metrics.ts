/**
 * WP-6 (O2) — Metrikák.
 *
 * Zéró-függőségű, in-process metrika-regiszter Prometheus szöveges
 * exposition-formátummal (a `/api/metrics` route szolgálja ki). GCP-n a
 * Cloud Run log-based metrics VAGY egy Prometheus-scrape egyaránt fogyaszthatja.
 *
 * Kulcs-jelek (6.2): gateway hívásszám & latency, broker deny-arány,
 * budget-kimerülés, dispatch-lag, 5xx-arány.
 */

type Labels = Record<string, string>

const DEFAULT_BUCKETS = [5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  return keys.map((k) => `${k}=${labels[k]}`).join(',')
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const inner = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',')
  return `{${inner}}`
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>()
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelKey(labels)
    const existing = this.series.get(key)
    if (existing) existing.value += delta
    else this.series.set(key, { labels, value: delta })
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`)
    }
    return lines.join('\n')
  }

  reset(): void {
    this.series.clear()
  }
}

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >()
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels)
    let s = this.series.get(key)
    if (!s) {
      s = { labels, buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, s)
    }
    s.sum += value
    s.count += 1
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.buckets[i] += 1
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const s of this.series.values()) {
      // s.buckets[i] már az adott `le`-küszöb alatti kumulatív darabszám (observe-ban
      // minden illeszkedo bucket no) → itt NEM kell újra összegezni.
      for (let i = 0; i < this.buckets.length; i++) {
        const le = { ...s.labels, le: String(this.buckets[i]) }
        lines.push(`${this.name}_bucket${renderLabels(le)} ${s.buckets[i]}`)
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${s.count}`)
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`)
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`)
    }
    return lines.join('\n')
  }

  reset(): void {
    this.series.clear()
  }
}

class Registry {
  private readonly counters = new Map<string, Counter>()
  private readonly histograms = new Map<string, Histogram>()

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name)
    if (!c) {
      c = new Counter(name, help)
      this.counters.set(name, c)
    }
    return c
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    let h = this.histograms.get(name)
    if (!h) {
      h = new Histogram(name, help, buckets)
      this.histograms.set(name, h)
    }
    return h
  }

  /** Prometheus text exposition — a `/api/metrics` route ezt adja vissza. */
  render(): string {
    const blocks: string[] = []
    for (const c of this.counters.values()) blocks.push(c.render())
    for (const h of this.histograms.values()) blocks.push(h.render())
    return blocks.join('\n\n') + '\n'
  }

  /** Csak teszthez — a globális állapot visszaállítása. */
  resetAll(): void {
    for (const c of this.counters.values()) c.reset()
    for (const h of this.histograms.values()) h.reset()
  }
}

export const registry = new Registry()

// ── Előre definiált kulcs-metrikák (6.2) ──────────────────────────────────────

/** Modellhívások száma állapot szerint (ok / rate_limited / error / budget_blocked). */
export const modelCallsTotal = registry.counter(
  'model_gateway_calls_total',
  'Model gateway calls by provider and status',
)
/** Modellhívás-latency ms-ben, provider szerint. */
export const modelCallLatencyMs = registry.histogram(
  'model_gateway_latency_ms',
  'Model gateway call latency in milliseconds',
)
/** Tool-broker hívások száma tool + státusz + döntés szerint (deny-arány számításához). */
export const toolBrokerCallsTotal = registry.counter(
  'tool_broker_calls_total',
  'Tool broker invocations by tool, status and policy decision',
)
/** Dispatch-események száma kimenet szerint (dispatched / budget_blocked / denied_inactive / error). */
export const dispatchTotal = registry.counter(
  'dispatcher_events_total',
  'Dispatcher outcomes by result',
)
/** Dispatch-lag ms-ben: mennyi idő telt a ticket ready-állapota óta a dispatchig. */
export const dispatchLagMs = registry.histogram(
  'dispatcher_lag_ms',
  'Time from ticket readiness to dispatch in milliseconds',
)
/** HTTP-válaszok száma státusz-osztály szerint (5xx-arányhoz). */
export const httpResponsesTotal = registry.counter(
  'http_responses_total',
  'HTTP responses by status class',
)
/** Elkapott kivételek száma forrás szerint (error-tracking). */
export const capturedExceptionsTotal = registry.counter(
  'captured_exceptions_total',
  'Exceptions captured by the error tracker, by source',
)

export { Counter, Histogram, Registry }
