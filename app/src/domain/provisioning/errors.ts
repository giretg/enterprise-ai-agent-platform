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
  | 'DRAFT_CHANGED_DURING_ACTIVATION' // a config/gate az aktiválási commit előtt megváltozott
  | 'SECRET_ALIAS_NOT_TRUSTED' // csak connector-owned vagy tenant-scope-ban engedélyezett külső alias
  | 'SECRET_ALIAS_MISSING'
  | 'OAUTH_CLIENT_ID_MISSING' // service-oauth2: hiányzik a config.auth.clientId
  | 'APPROVAL_SAME_ACTOR' // dual-control: reviewer === approver
  | 'DUAL_CONTROL_REQUIRED'
  | 'APPROVER_NOT_AUTHORIZED' // dual-control: a második jóváhagyó nem aktív, azonos-tenant admin
  | 'DUAL_CONTROL_NOT_CONFIGURED' // dual-control kötelező, de a jóváhagyó-ellenőrző nincs bekötve (fail-closed)
  | 'AGENT_NOT_IN_TENANT' // connector-agent kötés: a cél-agent nem az aktor tenantjáé
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
