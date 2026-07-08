/**
 * WP-6 (O2) — Error-tracking absztrakció.
 *
 * Pluggable kivétel-nyelő: alapból strukturált `error`-logot ír + számlálót növel,
 * de bekötheto egy külső sink (pl. Sentry `@sentry/nextjs` vagy GCP Error Reporting)
 * a `setErrorSink`-kel — a hívói felület (`captureException`) változatlan marad.
 * A kontextusba a WP-6 korrelációs mezők (requestId/tenantId/ticketId) kerülnek.
 */
import { logger, type LogFields } from './logger'
import { capturedExceptionsTotal } from './metrics'

export interface ErrorContext extends LogFields {
  source?: string
  requestId?: string | null
  tenantId?: string | null
  ticketId?: string | null
}

export type ErrorSink = (error: Error, context: ErrorContext) => void

let externalSink: ErrorSink | null = null

/** Külső error-sink bekötése (pl. Sentry). Prod-boot-on hívható, ha a DSN elérheto. */
export function setErrorSink(sink: ErrorSink | null): void {
  externalSink = sink
}

/**
 * Kezeletlen kivétel rögzítése kontextussal. A titkok/PII a logger redakcióján
 * mennek át; a stack-et külön mezoben adjuk, hogy ne redaktálódjon feleslegesen.
 */
export function captureException(error: unknown, context: ErrorContext = {}): void {
  const err = error instanceof Error ? error : new Error(String(error))
  const source = context.source ?? 'unknown'

  capturedExceptionsTotal.inc({ source })

  logger.error(
    {
      ...context,
      source,
      err: { name: err.name, message: err.message, stack: err.stack },
    },
    'captured exception',
  )

  if (externalSink) {
    try {
      externalSink(err, context)
    } catch (sinkError) {
      logger.error(
        { source: 'error-sink', err: String(sinkError) },
        'external error sink failed',
      )
    }
  }
}
