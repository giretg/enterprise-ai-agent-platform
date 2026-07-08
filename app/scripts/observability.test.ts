/**
 * WP-6 (O2) Observability — DB nélküli, tiszta logikai tesztek.
 * Fedi: strukturált logger redakció + korreláció + szint-szűrés, metrika-regiszter
 * (counter/histogram Prometheus-exposition), error-tracking sink + számláló,
 * kérés-korreláció (requestId átvétel/generálás).
 * Futtatás: npm run test:observability
 */
import assert from 'node:assert/strict'
import { Logger, redact, type LogRecord } from '../src/lib/observability/logger'
import { Registry } from '../src/lib/observability/metrics'
import {
  captureException,
  setErrorSink,
  type ErrorContext,
} from '../src/lib/observability/error-tracking'
import { capturedExceptionsTotal } from '../src/lib/observability/metrics'
import { resolveRequestId, REQUEST_ID_HEADER } from '../src/lib/observability/request-context'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

check('logger: strukturált JSON rekord level + time + msg mezőkkel', () => {
  const out: LogRecord[] = []
  const log = new Logger({}, (r) => out.push(r), 'info')
  log.info({ event: 'x', latencyMs: 12 }, 'hello')
  assert.equal(out.length, 1)
  assert.equal(out[0].level, 'info')
  assert.equal(out[0].msg, 'hello')
  assert.equal(out[0].event, 'x')
  assert.equal(out[0].latencyMs, 12)
  assert.ok(typeof out[0].time === 'string' && out[0].time.includes('T'))
})

check('logger: child() örökli és bővíti a korrelációs mezőket', () => {
  const out: LogRecord[] = []
  const log = new Logger({ service: 'broker' }, (r) => out.push(r), 'info')
  const child = log.child({ requestId: 'req-1', tenantId: 't-1' })
  child.info('scoped')
  assert.equal(out[0].service, 'broker')
  assert.equal(out[0].requestId, 'req-1')
  assert.equal(out[0].tenantId, 't-1')
})

check('logger: a titkok/PII redaktálva (secret/token/apiKey/prompt/messages)', () => {
  const out: LogRecord[] = []
  const log = new Logger({}, (r) => out.push(r), 'info')
  log.info({
    apiKey: 'sk-live-123',
    authorization: 'Bearer abc',
    nested: { token: 'zzz', ok: 'visible' },
    prompt: 'a nyers user-prompt SOHA nem kerülhet logba',
    messages: [{ role: 'user', content: 'titok' }],
    latencyMs: 5,
  })
  const r = out[0]
  assert.equal(r.apiKey, '[redacted]')
  assert.equal(r.authorization, '[redacted]')
  assert.equal((r.nested as Record<string, unknown>).token, '[redacted]')
  assert.equal((r.nested as Record<string, unknown>).ok, 'visible')
  assert.equal(r.prompt, '[redacted]')
  assert.equal(r.messages, '[redacted]')
  assert.equal(r.latencyMs, 5)
})

check('logger: szint-szűrés — a min alatti szint nem kerül a sinkbe', () => {
  const out: LogRecord[] = []
  const log = new Logger({}, (r) => out.push(r), 'warn')
  log.info('elnyomva')
  log.debug('elnyomva')
  log.warn('átmegy')
  log.error('átmegy')
  assert.equal(out.length, 2)
  assert.deepEqual(
    out.map((r) => r.level),
    ['warn', 'error'],
  )
})

check('redact: körhivatkozás nem okoz végtelen ciklust', () => {
  const a: Record<string, unknown> = { name: 'x' }
  a.self = a
  const safe = redact(a) as Record<string, unknown>
  assert.equal(safe.name, 'x')
  assert.equal(safe.self, '[circular]')
})

// ── Metrics ─────────────────────────────────────────────────────────────────

check('metrics: counter címkékkel aggregál és Prometheus-formátumot ad', () => {
  const reg = new Registry()
  const c = reg.counter('tool_calls_total', 'Tool calls')
  c.inc({ tool: 'web_search', status: 'ok' })
  c.inc({ tool: 'web_search', status: 'ok' })
  c.inc({ tool: 'board_write', status: 'denied' })
  const text = reg.render()
  assert.ok(text.includes('# TYPE tool_calls_total counter'))
  assert.ok(text.includes('tool_calls_total{status="ok",tool="web_search"} 2'))
  assert.ok(text.includes('tool_calls_total{status="denied",tool="board_write"} 1'))
})

check('metrics: histogram bucket/sum/count kumulatív + +Inf', () => {
  const reg = new Registry()
  const h = reg.histogram('lat_ms', 'Latency', [10, 100, 1000])
  h.observe(5)
  h.observe(50)
  h.observe(5000)
  const text = reg.render()
  assert.ok(text.includes('lat_ms_bucket{le="10"} 1'))
  assert.ok(text.includes('lat_ms_bucket{le="100"} 2'))
  assert.ok(text.includes('lat_ms_bucket{le="1000"} 2'))
  assert.ok(text.includes('lat_ms_bucket{le="+Inf"} 3'))
  assert.ok(text.includes('lat_ms_sum 5055'))
  assert.ok(text.includes('lat_ms_count 3'))
})

check('metrics: label-érték escape (idézőjel/backslash)', () => {
  const reg = new Registry()
  reg.counter('x_total', 'x').inc({ k: 'a"b\\c' })
  assert.ok(reg.render().includes('x_total{k="a\\"b\\\\c"} 1'))
})

// ── Error tracking ────────────────────────────────────────────────────────────

check('error-tracking: captureException növeli a számlálót + hívja a külső sinket', () => {
  capturedExceptionsTotal.reset()
  const captured: { err: Error; ctx: ErrorContext }[] = []
  setErrorSink((err, ctx) => captured.push({ err, ctx }))
  try {
    captureException(new Error('boom'), { source: 'gateway', requestId: 'req-9' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].err.message, 'boom')
    assert.equal(captured[0].ctx.source, 'gateway')
    assert.ok(capturedExceptionsTotal.render().includes('captured_exceptions_total{source="gateway"} 1'))
  } finally {
    setErrorSink(null)
  }
})

check('error-tracking: hibás külső sink nem propagál kivételt', () => {
  setErrorSink(() => {
    throw new Error('sink down')
  })
  try {
    // nem dobhat
    captureException('csak egy string', { source: 'test' })
  } finally {
    setErrorSink(null)
  }
})

// ── Request context ───────────────────────────────────────────────────────────

check('request-id: épkézláb bejövo értéket átvesz', () => {
  assert.equal(resolveRequestId('abc-123_XYZ.9'), 'abc-123_XYZ.9')
})

check('request-id: hiányzó/érvénytelen érték → friss UUID', () => {
  const gen = resolveRequestId(null)
  assert.match(gen, /^[0-9a-f-]{36}$/)
  // injektálás-veszélyes karakterek elutasítva (új UUID-t kapunk)
  const clean = resolveRequestId('bad value\nwith spaces')
  assert.notEqual(clean, 'bad value\nwith spaces')
  assert.match(clean, /^[0-9a-f-]{36}$/)
})

check('request-id: a fejléc-név kanonikus', () => {
  assert.equal(REQUEST_ID_HEADER, 'x-request-id')
})

console.log(
  failed === 0 ? `\nMinden teszt zöld (${passed}).` : `\n${failed} teszt bukott (${passed} zöld).`,
)
if (failed > 0) process.exit(1)
