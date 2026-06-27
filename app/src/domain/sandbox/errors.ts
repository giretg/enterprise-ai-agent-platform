/**
 * Tipizált hibák a Sandbox App Registryhez (Feature-spec — App Registry §10.2).
 * A `code` a spec negatív-teszt kódjaihoz igazodik, hogy az API-réteg
 * determinisztikusan tudjon róluk dönteni.
 */
export type SandboxAppErrorCode =
  | 'APP_NOT_FOUND_OR_FORBIDDEN'
  | 'APP_ARTIFACT_TOO_LARGE'
  | 'APP_VALIDATION_FAILED'
  | 'POLICY_NOT_ALLOWED_FOR_A0'
  | 'APP_VERSION_NOT_FOUND'
  | 'APP_INVALID_INPUT'

export class SandboxAppError extends Error {
  constructor(
    public readonly code: SandboxAppErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'SandboxAppError'
  }
}
