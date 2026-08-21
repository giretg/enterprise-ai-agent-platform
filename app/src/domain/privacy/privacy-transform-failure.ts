/**
 * APG-13 — rétegenkénti fail-closed / fail-open mátrix (spec §15).
 *
 * Strukturált mező és vault → fail-closed (modellhívás megáll, magyar üzenet).
 * Known-value: fail-closed ha strukturált forrásból jön, egyébként fail-open.
 * Scanner / user-input resolver → fail-open + audit, a workflow megy tovább.
 */
export type PrivacyTransformLayer =
  | 'structured_field'
  | 'known_value'
  | 'scanner'
  | 'vault'

export type PrivacyFailurePolicy = 'fail_closed' | 'fail_open'

export class VaultUnavailableError extends Error {
  constructor(message = 'Az álnév-tároló nem elérhető.') {
    super(message)
    this.name = 'VaultUnavailableError'
  }
}

/**
 * A chat és a ticket-felület ezt kapja — magyar, nem stack trace.
 * A `message` mező szándékosan megegyezik a felhasználónak mutatott szöveggel.
 */
export class PrivacyTransformBlockedError extends Error {
  readonly layer: PrivacyTransformLayer
  readonly userMessage: string

  constructor(layer: PrivacyTransformLayer, cause?: unknown) {
    const userMessage = privacyTransformBlockedMessage(layer)
    super(userMessage)
    this.name = 'PrivacyTransformBlockedError'
    this.layer = layer
    this.userMessage = userMessage
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/**
 * Diagnosztizálható privacy-hiba: az auditban NÉV szerint megmondja, melyik mezőn
 * és miért állt meg a transzformáció. Csak séma-információt hordoz (mezőnév,
 * hibaosztály) — nyers értéket soha.
 *
 * Enélkül az üzemeltető annyit lát, hogy „structured_field", és nem derül ki,
 * hogy például a forrásrendszer `id` testvérmezője hiányzik a rekordból.
 */
export class PrivacyFieldDiagnosticError extends Error {
  readonly code: string
  readonly field: string

  constructor(code: string, field: string, message: string) {
    super(message)
    this.name = 'PrivacyFieldDiagnosticError'
    this.code = code
    this.field = field
  }
}

export function isVaultUnavailableError(error: unknown): boolean {
  return error instanceof VaultUnavailableError
}

const FAILURE_BEHAVIOR: Record<
  PrivacyTransformLayer,
  { policy: PrivacyFailurePolicy; message: string }
> = {
  vault: {
    policy: 'fail_closed',
    message:
      'Az álnév-tároló jelenleg nem elérhető. Személyes adat védelme nélkül nem küldünk adatot a modellnek — a hívás megállt.',
  },
  structured_field: {
    policy: 'fail_closed',
    message:
      'A jelölt adatmező védelme most nem sikerült, ezért a modellhívás megállt. A nyers adat nem kerülhet külső modellhez. Próbáld újra később, vagy jelezd az üzemeltetőnek.',
  },
  known_value: {
    policy: 'fail_open',
    message:
      'A szövegben ismert adat cseréje nem sikerült, ezért a modellhívás megállt. A nyers adat nem kerülhet külső modellhez.',
  },
  scanner: {
    policy: 'fail_open',
    message:
      'A szöveges adatok automatikus felismerése most nem sikerült. A hívás megállt, hogy a nyers adat véletlenül se menjen ki.',
  },
}

export function failurePolicyForLayer(
  layer: PrivacyTransformLayer,
  opts?: { knownValueFromStructuredField?: boolean },
): PrivacyFailurePolicy {
  if (layer === 'known_value') {
    return opts?.knownValueFromStructuredField ? 'fail_closed' : 'fail_open'
  }
  return FAILURE_BEHAVIOR[layer].policy
}

export function effectiveFailureLayer(
  layer: PrivacyTransformLayer,
  error: unknown,
): PrivacyTransformLayer {
  return isVaultUnavailableError(error) ? 'vault' : layer
}

export function privacyTransformBlockedMessage(layer: PrivacyTransformLayer): string {
  return FAILURE_BEHAVIOR[layer].message
}

export type PrivacyTransformFailureAudit = {
  layer: PrivacyTransformLayer
  policy: PrivacyFailurePolicy
  reason: string
}

export function describePrivacyTransformFailure(error: unknown): string {
  if (error instanceof PrivacyFieldDiagnosticError) {
    return `${error.code}:${error.field}`
  }
  if (error instanceof PrivacyTransformBlockedError) {
    // A kiváltó ok részletesebb, mint a réteg neve — az auditba az kerüljön.
    const cause = error.cause
    if (cause instanceof PrivacyFieldDiagnosticError) {
      return `${error.layer}:${cause.code}:${cause.field}`
    }
    return error.layer
  }
  if (error instanceof VaultUnavailableError) return 'vault_unavailable'
  if (error instanceof Error) return error.name
  return 'unknown'
}

/**
 * ENFORCE úton futtat egy privacy-lépést a §15 mátrix szerint.
 * OBSERVE/OFF módban a hívó általában nem allokál — ott a work() tipikusan nem fut.
 */
export async function runPrivacyTransformLayer<T>(input: {
  layer: PrivacyTransformLayer
  knownValueFromStructuredField?: boolean
  work: () => Promise<T>
  onFailOpen: () => T
}): Promise<{ value: T; failure?: PrivacyTransformFailureAudit }> {
  try {
    return { value: await input.work() }
  } catch (error) {
    const layer = effectiveFailureLayer(input.layer, error)
    const policy = failurePolicyForLayer(layer, {
      knownValueFromStructuredField: input.knownValueFromStructuredField,
    })
    const failure: PrivacyTransformFailureAudit = {
      layer,
      policy,
      reason: describePrivacyTransformFailure(error),
    }
    if (policy === 'fail_closed') {
      throw new PrivacyTransformBlockedError(layer, error)
    }
    return { value: input.onFailOpen(), failure }
  }
}
