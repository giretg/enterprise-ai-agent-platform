/**
 * Agent-diagnosztika élő rétege: read-only próba + opt-in próba-írás.
 *
 * Szabályok (biztonság):
 *  - Küldés SOHA: a Gmail-írást piszkozat-létrehozás + azonnali törlés bizonyítja.
 *  - A Drive-írást mappa-létrehozás + azonnali kukázás bizonyítja, jól látható
 *    `[Diagnosztika – törölhető]` névvel, hogy egy elakadt takarítás se okozzon kárt.
 *  - Olyan connector-típusra, amihez nincs próba definiálva, `unknown` az eredmény
 *    („nem tesztelhető automatikusan") — az új API-k nem törik pirosra a listát.
 *  - A hibaüzenet sanitizált: státuszkód + ok-kategória, host/token soha.
 */

import type { DiagnosticCheck } from './agent-diagnostics'

/** A próba-írások jelölése — a felhasználó Drive-jában/Gmailjében is felismerhető. */
export const DIAGNOSTICS_PROBE_MARKER = '[Diagnosztika – törölhető]'

export type ProbeOutcome = 'ok' | 'warn' | 'fail' | 'unknown'

export interface ProbeResult {
  id: string
  label: string
  outcome: ProbeOutcome
  /** Sanitizált ok-kategória (pl. 'timeout', 'auth_failed', 'not_testable'). */
  reason: string
  fixSection: DiagnosticCheck['fixSection']
}

export function probeResultToCheck(result: ProbeResult): DiagnosticCheck {
  return {
    id: result.id,
    label: result.label,
    status: result.outcome,
    detail: probeDetail(result),
    fixSection: result.fixSection,
  }
}

function probeDetail(result: ProbeResult): string {
  switch (result.reason) {
    case 'reachable':
      return 'Az élő kapcsolat elérhető, a jogosultság érvényes.'
    case 'reachable_auth_required':
      return 'A rendszer elérhető, de a próba token nélkül futott — a tényleges hozzáférés a fiók-összekötéstől függ.'
    case 'write_probe_ok':
      return 'A próba-írás (létrehozás + azonnali törlés) sikerült, nem maradt utána semmi.'
    case 'cleanup_failed':
      return 'A próbaelem létrejött, de az automatikus törlés nem sikerült. A megjelölt piszkozatot vagy mappát töröld kézzel.'
    case 'no_grant':
      return 'Nincs összekötött fiók ehhez a kapcsolathoz — az élő próba fiók nélkül nem fut.'
    case 'auth_failed':
      return 'A fiók-hozzáférés lejárt vagy visszavonták — kösd össze újra.'
    case 'not_testable':
      return 'Ehhez a kapcsolattípushoz nincs automatikus próba — ha gyanús, kézzel ellenőrizd.'
    case 'timeout':
      return 'Időtúllépés: a külső rendszer most nem válaszolt időben.'
    default:
      return 'Az élő próba most nem sikerült.'
  }
}

/** Hibák sanitizálása: csak kategória, soha host/token/üzenet. */
export function sanitizeProbeError(error: unknown): 'timeout' | 'auth_failed' | 'request_failed' {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout'
  if (/401|403|auth|grant_token_expired|expired|revoked|insufficient/i.test(message)) return 'auth_failed'
  return 'request_failed'
}

export function publicDiagnosticsError(error: unknown): string {
  void error
  return 'Az agent tesztelése sikertelen.'
}

/** Időkorlátos futtatás — a diagnosztika sose lógjon egy lassú API-n. */
export async function withProbeTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, ms = 8000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), ms)
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function runWriteProbe(
  create: (signal: AbortSignal) => Promise<string>,
  cleanup: (id: string, signal: AbortSignal) => Promise<unknown>,
): Promise<'write_probe_ok' | 'cleanup_failed'> {
  const id = await withProbeTimeout(create)
  try {
    await withProbeTimeout((signal) => cleanup(id, signal))
    return 'write_probe_ok'
  } catch {
    return 'cleanup_failed'
  }
}
