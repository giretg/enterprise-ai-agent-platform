/**
 * WP-6 (O2) — Strukturált naplózó.
 *
 * Zéró-függőségű, determinisztikus JSON-logger (pino-kompatibilis felület:
 * `logger.info(fields, msg)` / `logger.child(bindings)`), hogy a boot fail-closed
 * maradjon és ne bővítsük a supply-chain felületet. Ha később `pino`-ra váltunk,
 * a hívói felület változatlan marad.
 *
 * Kulcs-elv (az audit-lánccal egyezően): a logban SOHA nincs nyers prompt / PII /
 * titok — a mezők kulcs-név alapján redaktálódnak (`REDACT_KEYS`).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type LogFields = Record<string, unknown>

export interface LogRecord extends LogFields {
  level: LogLevel
  time: string
  msg?: string
}

export type LogSink = (record: LogRecord) => void

/**
 * Kulcs-nevek, amelyek értékét REDAKTÁLJUK (case-insensitive, rész-egyezés is).
 * A `prompt`/`content` a nyers-modell-bemenetet fedi — SOHA nem naplózzuk.
 */
export const REDACT_KEYS = [
  'secret',
  'token',
  'apikey',
  'authorization',
  'password',
  'cookie',
  'prompt',
  'content',
  'messages',
] as const

const REDACTED = '[redacted]'

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase()
  return REDACT_KEYS.some((needle) => k.includes(needle))
}

/** Rekurzív, kulcs-név alapú redakció; körhivatkozás-biztos, mélység-limitált. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) return '[depth-limit]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = shouldRedact(k) ? REDACTED : redact(v, depth + 1, seen)
  }
  return out
}

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

/** Alapértelmezett sink: egy sor / rekord JSON-ként a stdout-ra (GCP Cloud Logging-barát). */
export const stdoutSink: LogSink = (record) => {
  process.stdout.write(JSON.stringify(record) + '\n')
}

export class Logger {
  constructor(
    private readonly bindings: LogFields = {},
    private readonly sink: LogSink = stdoutSink,
    private readonly minLevel: LogLevel = envLevel(),
  ) {}

  /** Korrelációs mezőkkel bővített gyerek-logger (requestId/tenantId/ticketId). */
  child(bindings: LogFields): Logger {
    return new Logger({ ...this.bindings, ...bindings }, this.sink, this.minLevel)
  }

  private emit(level: LogLevel, fieldsOrMsg?: LogFields | string, maybeMsg?: string): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return

    let fields: LogFields = {}
    let msg: string | undefined
    if (typeof fieldsOrMsg === 'string') {
      msg = fieldsOrMsg
    } else if (fieldsOrMsg) {
      fields = fieldsOrMsg
      msg = maybeMsg
    }

    const merged = { ...this.bindings, ...fields }
    const safe = redact(merged) as LogFields
    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      ...safe,
      ...(msg !== undefined ? { msg } : {}),
    }
    this.sink(record)
  }

  debug(fields?: LogFields | string, msg?: string): void {
    this.emit('debug', fields, msg)
  }
  info(fields?: LogFields | string, msg?: string): void {
    this.emit('info', fields, msg)
  }
  warn(fields?: LogFields | string, msg?: string): void {
    this.emit('warn', fields, msg)
  }
  error(fields?: LogFields | string, msg?: string): void {
    this.emit('error', fields, msg)
  }
}

/** Folyamat-szintű gyökér-logger. */
export const logger = new Logger()

/** Kérésenkénti gyerek-logger korrelációs mezőkkel. */
export function requestLogger(ctx: {
  requestId: string
  tenantId?: string | null
  ticketId?: string | null
}): Logger {
  return logger.child(ctx)
}
