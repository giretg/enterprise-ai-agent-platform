/**
 * Tipizált hibák a Provisioning Assistant (Connector Onboarding) feature-höz
 * (Feature-spec — Provisioning-Assistant §8, §12.2). A `code` a spec negatív-teszt
 * kódjaihoz igazodik, hogy az API-réteg determinisztikusan tudjon róluk dönteni.
 */
export type ProvisioningErrorCode =
  | 'DRAFT_NOT_FOUND_OR_FORBIDDEN'
  | 'PROVISIONING_INVALID_INPUT'
  | 'PROVISIONING_FORBIDDEN' // kemény padló: agent/jogosulatlan aktus (CR-MVP-002)
  | 'TOOL_NOT_AUTHORIZED' // agent megpróbál nem-létező privilegizált toolt hívni
  | 'DRAFT_VALIDATION_FAILED'
  | 'DRAFT_NOT_APPROVED'
  | 'SANDBOX_TEST_FAILED'
  | 'SECRET_ALIAS_MISSING'
  | 'APPROVAL_SAME_ACTOR' // dual-control: reviewer === approver
  | 'DUAL_CONTROL_REQUIRED'
  | 'CONNECTOR_NOT_DRAFT'

export class ProvisioningError extends Error {
  constructor(
    public readonly code: ProvisioningErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProvisioningError'
  }
}
