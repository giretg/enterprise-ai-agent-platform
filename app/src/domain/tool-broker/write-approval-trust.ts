/**
 * issue #220 — agent↔connector írás-bizalom (`writeApproval`).
 *
 * A kapu-policy és az admin mentés közös típusai / validációja.
 * Nincs `per_run` trust-szint — az hazudna kontrollt.
 */

export const WRITE_APPROVAL_MODES = ['per_call', 'preapproved'] as const
export type WriteApprovalMode = (typeof WRITE_APPROVAL_MODES)[number]

export const PREAPPROVED_TRUST_MODES = ['lax', 'strict'] as const
export type PreapprovedTrustMode = (typeof PREAPPROVED_TRUST_MODES)[number]

export const CONSEQUENCE_BOUNDARIES = ['external_draft', 'platform'] as const
export type ConsequenceBoundary = (typeof CONSEQUENCE_BOUNDARIES)[number]

/** Szigorú mód javasolt előtöltés (admin UI). */
export const PREAPPROVED_SUGGESTED_WRITE_LIMIT = 100
export const PREAPPROVED_SUGGESTED_EXPIRY_DAYS = 90

/** Hard cap — mentéskor és futásidőben. */
export const PREAPPROVED_MAX_WRITE_LIMIT = 500
export const PREAPPROVED_MAX_EXPIRY_DAYS = 365

export type WriteApprovalTrust = {
  mode: WriteApprovalMode
  trustMode: PreapprovedTrustMode | null
  expiresAt: Date | null
  writeLimitPerRun: number | null
  dangerPreapproved: boolean
}

export const DEFAULT_WRITE_APPROVAL_TRUST: WriteApprovalTrust = {
  mode: 'per_call',
  trustMode: null,
  expiresAt: null,
  writeLimitPerRun: null,
  dangerPreapproved: false,
}

export type WriteApprovalBindingInput = {
  writeApproval: WriteApprovalMode
  /** Kötelező, ha writeApproval = preapproved. Nincs előjelölt default. */
  preapprovedTrustMode?: PreapprovedTrustMode | null
  /** ISO dátum vagy Date. Szigorú módban kötelező. */
  preapprovedExpiresAt?: string | Date | null
  /** Szigorú módban kötelező. */
  preapprovedWriteLimit?: number | null
  dangerPreapproved?: boolean
}

export type WriteApprovalValidationOk = { ok: true; trust: WriteApprovalTrust }
export type WriteApprovalValidationErr = { ok: false; error: string }

/**
 * Admin mentés validálása. `per_call` törli a preapproved mezőket.
 * `preapproved` esetén kötelező a laza/szigorú választás (nincs default).
 */
export function validateWriteApprovalBinding(
  input: WriteApprovalBindingInput,
  now: Date = new Date(),
): WriteApprovalValidationOk | WriteApprovalValidationErr {
  const mode = input.writeApproval
  if (mode !== 'per_call' && mode !== 'preapproved') {
    return { ok: false, error: 'Érvénytelen írási bizalom (writeApproval).' }
  }

  if (mode === 'per_call') {
    return {
      ok: true,
      trust: {
        ...DEFAULT_WRITE_APPROVAL_TRUST,
        dangerPreapproved: false,
      },
    }
  }

  const trustMode = input.preapprovedTrustMode
  if (trustMode !== 'lax' && trustMode !== 'strict') {
    return {
      ok: false,
      error: 'Előzetes engedélyhez válassz módot: laza (csak audit) vagy szigorú (limit + lejárat).',
    }
  }

  const dangerPreapproved = Boolean(input.dangerPreapproved)
  let expiresAt: Date | null = null
  let writeLimitPerRun: number | null = null

  if (trustMode === 'strict') {
    const limit = input.preapprovedWriteLimit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return {
        ok: false,
        error: `Szigorú módhoz add meg az író hívás limitet (1–${PREAPPROVED_MAX_WRITE_LIMIT} / futás).`,
      }
    }
    if (limit > PREAPPROVED_MAX_WRITE_LIMIT) {
      return {
        ok: false,
        error: `Az író hívás limit legfeljebb ${PREAPPROVED_MAX_WRITE_LIMIT} / futás lehet.`,
      }
    }
    writeLimitPerRun = limit

    const parsedExpiry = parseExpiry(input.preapprovedExpiresAt)
    if (!parsedExpiry.ok) return parsedExpiry
    if (!parsedExpiry.value) {
      return { ok: false, error: 'Szigorú módhoz add meg a lejárati dátumot.' }
    }
    const maxExpiry = new Date(now.getTime() + PREAPPROVED_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    if (parsedExpiry.value.getTime() <= now.getTime()) {
      return { ok: false, error: 'A lejáratnak a jövőben kell lennie.' }
    }
    if (parsedExpiry.value.getTime() > maxExpiry.getTime()) {
      return {
        ok: false,
        error: `A lejárat legfeljebb ${PREAPPROVED_MAX_EXPIRY_DAYS} nap lehet.`,
      }
    }
    expiresAt = parsedExpiry.value
  } else if (input.preapprovedExpiresAt != null && input.preapprovedExpiresAt !== '') {
    const parsedExpiry = parseExpiry(input.preapprovedExpiresAt)
    if (!parsedExpiry.ok) return parsedExpiry
    if (parsedExpiry.value) {
      if (parsedExpiry.value.getTime() <= now.getTime()) {
        return { ok: false, error: 'A lejáratnak a jövőben kell lennie.' }
      }
      const maxExpiry = new Date(now.getTime() + PREAPPROVED_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
      if (parsedExpiry.value.getTime() > maxExpiry.getTime()) {
        return {
          ok: false,
          error: `A lejárat legfeljebb ${PREAPPROVED_MAX_EXPIRY_DAYS} nap lehet.`,
        }
      }
      expiresAt = parsedExpiry.value
    }
  }

  return {
    ok: true,
    trust: {
      mode: 'preapproved',
      trustMode,
      expiresAt,
      writeLimitPerRun,
      dangerPreapproved,
    },
  }
}

function parseExpiry(
  raw: string | Date | null | undefined,
): { ok: true; value: Date | null } | WriteApprovalValidationErr {
  if (raw == null || raw === '') return { ok: true, value: null }
  const value = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(value.getTime())) {
    return { ok: false, error: 'Érvénytelen lejárati dátum.' }
  }
  return { ok: true, value }
}

/** DB / repository sor → futásidejű trust. Ismeretlen / hiányzó → per_call. */
export function writeApprovalTrustFromRow(row: {
  writeApproval?: string | null
  preapprovedTrustMode?: string | null
  preapprovedExpiresAt?: Date | string | null
  preapprovedWriteLimit?: number | null
  dangerPreapproved?: boolean | null
}): WriteApprovalTrust {
  if (row.writeApproval !== 'preapproved') return { ...DEFAULT_WRITE_APPROVAL_TRUST }
  const trustMode =
    row.preapprovedTrustMode === 'lax' || row.preapprovedTrustMode === 'strict'
      ? row.preapprovedTrustMode
      : null
  // Hibás / hiányos preapproved sor → fail-safe per_call (ne skipeljen kaput).
  if (!trustMode) return { ...DEFAULT_WRITE_APPROVAL_TRUST }
  const expiresAt =
    row.preapprovedExpiresAt instanceof Date
      ? row.preapprovedExpiresAt
      : typeof row.preapprovedExpiresAt === 'string'
        ? new Date(row.preapprovedExpiresAt)
        : null
  const writeLimitPerRun =
    typeof row.preapprovedWriteLimit === 'number' && row.preapprovedWriteLimit > 0
      ? Math.min(row.preapprovedWriteLimit, PREAPPROVED_MAX_WRITE_LIMIT)
      : null
  if (trustMode === 'strict' && (writeLimitPerRun == null || !expiresAt || Number.isNaN(expiresAt.getTime()))) {
    return { ...DEFAULT_WRITE_APPROVAL_TRUST }
  }
  return {
    mode: 'preapproved',
    trustMode,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    writeLimitPerRun,
    dangerPreapproved: Boolean(row.dangerPreapproved),
  }
}

export function consequenceBoundaryLabel(boundary: ConsequenceBoundary | null | undefined): string | null {
  switch (boundary) {
    case 'external_draft':
      return 'Külső rendszer draftja (javaslat: előzetes engedély megfontolható)'
    case 'platform':
      return 'Platform a következmény-határ (maradjon hívásonkénti kapu)'
    default:
      return null
  }
}

export function suggestedExpiryIso(days: number = PREAPPROVED_SUGGESTED_EXPIRY_DAYS, now = new Date()): string {
  const d = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
