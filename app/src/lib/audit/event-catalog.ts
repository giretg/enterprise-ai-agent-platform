/**
 * Kötelező eseménytípus-katalógus (Feature-spec AuditLog-Observability §5).
 * Minden `AuditRepository.append()` hívás `action` mezője itt regisztrálva kell legyen —
 * ismeretlen típus fail-fast elutasítást kap, hogy ne keletkezzen "szabad szöveg" esemény.
 *
 * A lista a jelenlegi kódbázisban ténylegesen használt action-stringeket tükrözi
 * (grep-pelve minden `repositories.audit.append(...)` hívási helyről), nem csak a
 * spec 5. fejezetének mintatáblázatát — a platform több komponense (Monitor, Provisioning,
 * Dispatcher, Web Search kill-switch stb.) a spec táblázatánál bővebb eseménykört ír.
 *
 * Bővítési szabály: új action bevezetésekor ide fel kell venni, különben `append()` eldobja.
 */
export const REGISTERED_AUDIT_ACTIONS = new Set<string>([
  // IAM / RBAC (access.*, user.*)
  'access.denied',
  'user.authz.deny',
  'user.invite.issue',
  'user.invite.redeem',
  'user.invite.revoke',
  'user.permission.update',
  'user.profile.update',
  'user.reactivate',
  'user.role.assign',
  'user.role.change',
  'user.selfregister',
  'user.suspend',

  // Agent Registry
  'agent.avatar',
  'agent.activated',
  'agent.api_key_revoked',
  'agent.api_key_rotated',
  'agent.behavior_profile_set',
  'agent.behavior_profile_update_accepted',
  'agent.behavior_profile_updated',
  'agent.create',
  'agent.delete',
  'agent.dispatch_denied_inactive',
  'agent.resumed',
  'agent.retired',
  'agent.self_evolution_profile_change',
  'agent.suspended',
  'agent.version',
  'behavior_profile.created',
  'capability.update',

  // Connectors / Provisioning
  'connector.create',
  'connector.materialize',
  'connector.template.clone',
  'connector.template.create',
  'connector.template.deprecate',
  'connector.grant.create',
  'connector.grant.expire',
  'connector.grant.refresh',
  'connector.grant.revoke',
  'connector.update',
  'provisioning.access_denied',
  'provisioning.connector.activate',
  'provisioning.connector.assign',
  'provisioning.connector.unassign',
  'provisioning.connector.reopen',
  'provisioning.connector.decommission',
  'provisioning.draft.create',
  'provisioning.draft.update',
  'provisioning.draft.delete',
  'provisioning.draft.reject',
  'provisioning.draft.review',
  'provisioning.draft.validate',
  'access_draft',
  // Provisioning Web-Discovery (WebFetch-Egress §11.1)
  'provisioning.discover.search',
  'provisioning.discover.draft',
  'provisioning.discover.blocked',
  'connector.egress_allowlist.extend',

  // ConversationSession
  'context.assembled',
  'context.truncated',
  'conversation.archive',
  'conversation.content_deleted',
  'conversation.create',
  'conversation.promote_to_ticket',
  'message.append',
  'message.content_deleted',

  // Model Gateway
  'model.call',
  'model.call.denied',
  'model.call.sensitivity_override',
  'model_policy.upsert',

  // Tool Broker
  'tool.call',
  'tool.call.denied',

  // Delegation
  'delegation.create',
  'delegation.return',

  // Dispatcher
  'dispatch.blocked',
  'dispatch.budget_blocked',
  'dispatch.complete',
  'dispatch.complete.denied',
  'dispatch.error',
  'dispatch.notify.failed',
  'dispatch.notify.sent',
  'dispatch.start',
  'dispatch.timeout',
  'dispatcher.config_changed',
  'dispatcher.paused',
  'dispatcher.resumed',

  // MemoryTraining / write-gate
  'memory.rollback',
  'memory.update',
  'memory.write.eval_blocked',
  'memory.write.eval_override',
  'memory.write_denied',
  'training.capability_escalation_denied',

  // Knowledge base
  'kb.document.approved',
  'kb.document.deleted',
  'kb.document.rejected',
  'kb.shared',
  'kb.unshared',
  // KB-v3 OKF artifact flow (§13)
  'kb.artifact.generated',
  'kb.artifact.validation_failed',
  'kb.artifact.published',
  'kb.artifact.rejected',

  // Proactive Monitor
  'monitor.config_changed',
  'monitor.lock_reclaimed',
  'monitor.notify.failed',
  'monitor.notify.sent',
  'monitor.paused',
  'monitor.resumed',
  'monitor.sweep.error',
  'monitor.sweep.escalated',
  'monitor.sweep.quiet',
  'monitor.sweep.skipped',
  'monitor.sweep.suppressed',

  // Playbook / process runtime
  'gate.approve',
  'gate.bypass_denied',
  'playbook.approve',
  'playbook.assignment.create',
  'playbook.create',
  'playbook.pack.import',
  'playbook.update_meta',
  'playbook.version.create',
  'playbook.version.publish',
  'playbook.version.reject',
  'playbook.version.submit',
  'playbook.version.update',
  'playbook.version.validate',
  'step_template.certify',
  'step_template.create',
  'step_template.delete',
  'step_template.publish',
  'step_template.retire',
  'step_template.version.create',
  'process.cancel',
  'process.blocked',
  'process.complete',
  'process_definition.activate',
  'process_definition.archive',
  'process_definition.attach_trigger',
  'process_definition.create',
  'process_definition.detach_trigger',
  'process_definition.rebind_version',
  'process_definition.replace_active',
  'process_definition.update_bindings',
  'process.start',
  'process.step.advance',
  'process.step.await_gate',
  'process.step.complete',
  'process.step.create',
  'process.step.dispatch_deferred',
  'ticket.comment.add',
  'ticket.comment.attachment.uploaded',
  'ticket.runas.authorize',
  'ticket.runas.revoke',
  'ticket.transition',
  'ticket.transition.denied',
  'ticket_type.upsert',
  'scheduled_task.create',
  'scheduled_task.materialize',
  'scheduled_task.reclaim',
  'scheduled_task.revoke',

  // Recipe
  'recipe.approve',
  'recipe.create',
  'recipe.version',

  // Skill-katalógus (skill-catalog-spec.md, WP-7)
  'skill.imported',
  'skill.created',
  'skill.version.proposed',
  'skill.version.approved',
  'skill.assigned',
  'skill.unassigned',
  'skill.loaded',
  'skill.rolled_back',
  'skill.access_denied',

  // Sandbox App Registry
  'retention.sweep',
  'sandbox_app.access_denied',
  'sandbox_app.archive',
  'sandbox_app.create',
  'sandbox_app.export',
  'sandbox_app.preview',
  'sandbox_app.read',
  'sandbox_app.validation_failed',
  'sandbox_app.version.activate',
  'sandbox_app.version.create',

  // Sandbox verziózás / promóció / graduation (SandboxVersioning-Graduation §8.1)
  'sandbox.commit',
  'sandbox.rollback',
  'sandbox.promote.request',
  'sandbox.promote.approve',
  'sandbox.promote.reject',
  'sandbox.snapshot.create',
  'sandbox.snapshot.restore',
  'sandbox.export.request',
  'sandbox.export.ready',
  'sandbox.export.delivered',
  'sandbox.access_denied',

  // Web Search Tool kill-switch
  'web_search.config_changed',
  'web_search.paused',
  'web_search.resumed',

  // Web Fetch (WS-D) platform-tool (WebFetch-Egress §11.1)
  'web_fetch.request',
  'web_fetch.blocked',
  'web_fetch.config_changed',
  'web_fetch.paused',
  'web_fetch.resumed',

  // Agent-agnostic Web Research delegation
  'agent.web_research.requested',
  'agent.web_research.completed',
  'agent.web_research.blocked',

  // Platform / DB mode
  'database.mode_changed',
  'database.test_synced_from_production',
  'workspace.tenant.purge',
])

export class UnregisteredAuditActionError extends Error {
  constructor(action: string) {
    super(
      `Unregistered audit action: "${action}" — add it to REGISTERED_AUDIT_ACTIONS (src/lib/audit/event-catalog.ts) before writing it`,
    )
    this.name = 'UnregisteredAuditActionError'
  }
}

export function assertAuditActionRegistered(action: string): void {
  if (!REGISTERED_AUDIT_ACTIONS.has(action)) {
    throw new UnregisteredAuditActionError(action)
  }
}
