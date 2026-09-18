/**
 * Kötelező eseménytípus-katalógus. Minden `AuditRepository.append()` `action`
 * mezője itt kell legyen — ismeretlen típus fail-fast.
 *
 * Phase F: a chat/ticket/dispatcher/memory/monitor/model.call források nincsenek
 * a live `app/`-ban. A lista a még létező writer-ekre van nyesve.
 */
export const CORE_MVP_AUDIT_ACTIONS = [
  'mcp.auth.ok',
  'mcp.auth.deny',
  'mcp.tools.call',
  'mcp.tools.call.deny',
  'enterprise.tool.ok',
  'enterprise.tool.denied',
  'enterprise.tool.error',
  'gateway.operation.enqueued',
  'gateway.operation.approved',
  'gateway.operation.rejected',
  'gateway.operation.executing',
  'gateway.operation.succeeded',
  'gateway.operation.failed',
] as const

export const REGISTERED_AUDIT_ACTIONS = new Set<string>([
  ...CORE_MVP_AUDIT_ACTIONS,

  'access.denied',
  'user.authz.deny',
  'user.invite.issue',
  'user.invite.redeem',
  'user.invite.revoke',
  'user.permission.update',
  'user.profile.update',
  'user.provision.claim',
  'user.provision.create',
  'user.reactivate',
  'user.role.assign',
  'user.role.change',
  'user.selfregister',
  'user.suspend',

  'platform.role.grant',
  'platform.role.revoke',
  'platform.oauth.google.update',
  'platform.oauth.google_drive.update',
  'platform.oauth.google_drive_picker.update',

  'tenant.create',
  'tenant.suspend',
  'tenant.offboard',
  'tenant.archive',
  'tenant.reactivate',
  'tenant.assume',
  'tenant.switch',
  'tenant.exit',
  'tenant.member.add',
  'tenant.member.update',
  'tenant.member.role.change',
  'tenant.member.suspend',
  'tenant.member.invite_accept',
  'tenant.language.update',
  'tenant.nav_visibility.update',
  'tenant.oauth.google.update',
  'tenant.self_update.policy.update',

  'agent.create',
  'agent.activated',
  'agent.version',
  'agent.suspended',
  'agent.resumed',
  'agent.retired',
  'agent.delete',
  'agent.avatar',
  'agent.access.granted',
  'agent.access.denied',

  'capability.update',
  'connector.create',
  'connector.update',
  'connector.binding.update',
  'connector.grant.create',
  'connector.grant.expire',
  'connector.grant.refresh',
  'connector.grant.revoke',

  'provisioning.access_denied',
  'provisioning.connector.activate',
  'provisioning.connector.assign',
  'provisioning.connector.decommission',
  'provisioning.connector.reopen',
  'provisioning.connector.unassign',
  'provisioning.draft.create',
  'provisioning.draft.delete',
  'provisioning.draft.reject',
  'provisioning.draft.review',
  'provisioning.draft.update',
  'provisioning.draft.validate',

  'privacy.connector.capability.absent',
  'privacy.connector.capability.changed',
  'privacy.catalog.sync.applied',
  'privacy.catalog.sync.failed',

  'skill.blocked_unready',
  'skill.access_denied',
  'skill.assigned',
  'skill.unassigned',
  'skill.created',
  'skill.deleted',
])

export class UnregisteredAuditActionError extends Error {
  constructor(action: string) {
    super(`Unregistered audit action: ${action}`)
    this.name = 'UnregisteredAuditActionError'
  }
}

export function assertAuditActionRegistered(action: string): void {
  if (!REGISTERED_AUDIT_ACTIONS.has(action)) {
    throw new UnregisteredAuditActionError(action)
  }
}
