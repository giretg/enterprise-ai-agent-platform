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
  | 'ACTIVATION_AUTH_TEST_FAILED'
  | 'ACTIVATION_KEYLESS_UNCONFIRMED'
  | 'SECRET_ALIAS_MISSING'
  | 'OAUTH_CLIENT_ID_MISSING' // service-oauth2: hiányzik a config.auth.clientId
  | 'APPROVAL_SAME_ACTOR' // dual-control: reviewer === approver
  | 'DUAL_CONTROL_REQUIRED'
  | 'CONNECTOR_NOT_DRAFT'
  | 'DRAFT_NOT_EDITABLE' // javítás: csak draft/validated config szerkeszthető
  | 'CONNECTOR_NOT_ACTIVE' // reopen/decommission: csak aktív connectorra
  | 'CONNECTOR_NOT_FOUND_OR_FORBIDDEN' // connector-hozzáférés: nem a tenant connectora
  | 'CONNECTOR_NOT_ASSIGNABLE' // self_updating: nincs aktív/valid capability snapshot
  | 'DRAFT_ALREADY_ACTIVATED' // hard-delete: csak sosem aktivált draftra

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
