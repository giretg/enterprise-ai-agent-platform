/**
 * Tipizált hibák a Sandbox verziózás / promóció / graduation feature-höz
 * (Feature-spec — SandboxVersioning-Graduation §11.2). A `code` a spec negatív-teszt
 * kódjaihoz igazodik, hogy az API-réteg determinisztikusan tudjon dönteni.
 */
export type SandboxVersionErrorCode =
  | 'SANDBOX_NOT_FOUND_OR_FORBIDDEN'
  | 'SANDBOX_INVALID_INPUT'
  | 'COMMIT_NOT_FOUND'
  | 'PROMOTION_NOT_FOUND'
  | 'PROMOTION_ALREADY_DECIDED'
  | 'PROMOTION_STALE_HEAD'
  | 'PROMOTION_FAILED_NO_SNAPSHOT'
  | 'SNAPSHOT_NOT_FOUND'
  | 'EXPORT_NOT_FOUND'
  | 'EXPORT_SNAPSHOT_REQUIRED'
  | 'TOOL_NOT_AUTHORIZED'
  | 'FORBIDDEN_AGENT_ACTION'
  | 'FORBIDDEN_ROLE'

export class SandboxVersionError extends Error {
  constructor(
    public readonly code: SandboxVersionErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'SandboxVersionError'
  }
}
