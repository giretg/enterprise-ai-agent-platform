/**
 * Kötelező eseménytípus-katalógus. Minden `AuditRepository.append()` `action`
 * mezője itt kell legyen — ismeretlen típus fail-fast.
 *
 * Phase F: a lista a live `app/` writer-ekre van nyesve (nincs chat/ticket/sín).
 */
export const CORE_MVP_AUDIT_ACTIONS = [
  'mcp.auth.ok',
  'mcp.auth.deny',
  'mcp.tools.call',
  'mcp.tools.call.deny',
  'mcp.resources.read',
  'enterprise.tool.ok',
  'enterprise.tool.denied',
  'enterprise.tool.error',
  'gateway.operation.enqueued',
  'gateway.operation.approved',
  'gateway.operation.rejected',
  'gateway.operation.executing',
  'gateway.operation.succeeded',
  'gateway.operation.failed',
  'gateway.operation.confirm_mismatch',
] as const

export const REGISTERED_AUDIT_ACTIONS = new Set<string>([
  ...CORE_MVP_AUDIT_ACTIONS,

  'user.authz.deny',
  'user.invite.issue',
  'user.invite.redeem',
  'user.invite.revoke',
  'user.permission.update',
  'user.provision.claim',
  'user.provision.create',
  'user.reactivate',
  'user.role.assign',
  'user.role.change',
  'user.agent_access.update',
  'user.suspend',

  'platform.role.grant',
  'platform.role.revoke',

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

  'agent.create',
  'agent.activated',
  'agent.version',
  'agent.delete',
  'agent.profile',
  'agent.memory_write_mode',
  'agent.user.grant',
  'agent.user.revoke',

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
  'provisioning.doc.fetch',
  'provisioning.doc.fetch.blocked',
  'connector.egress_allowlist.extend',
  'connector.materialize',
  'connector.template.create',
  'connector.template.deprecate',
  'connector.self_update.create',
  'connector.self_update.source.approve',
  'connector.self_update.trust.approve',
  'connector.self_update.policy.update',
  'connector.self_update.sync.proposed',
  'connector.self_update.sync.failed',
  'connector.self_update.sync.no_change',
  'connector.self_update.version.approve',
  'connector.self_update.version.auto_approve',
  'connector.self_update.version.reject',
  'connector.self_update.version.rollback',
  'connector.self_update.api_key.rotate',
  'tenant.self_update.policy.update',

  'privacy.connector.capability.absent',
  'privacy.connector.capability.changed',

  'kb.document.ingested',
  'kb.document.deleted',
  'kb.catalog.attached',

  'skill.conversation.created',
  'skill.conversation.proposed',
  'skill.conversation.proposal.overwritten',
  'skill.conversation.approved',
  'skill.conversation.rejected',

  'project.create',
  'project.work_file.write',
  'project.work_file.delete',
  'project.project_memory.write',
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
