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
  'user.reactivate',
  'user.role.assign',
  'user.role.change',
  'user.selfregister',
  'user.suspend',

  // Agent Registry
  'agent.activated',
  'agent.api_key_revoked',
  'agent.api_key_rotated',
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
  'dispatch.budget_blocked',
  'dispatch.complete',
  'dispatch.complete.denied',
  'dispatch.error',
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
  'playbook.version.create',
  'playbook.version.publish',
  'playbook.version.reject',
  'playbook.version.submit',
  'playbook.version.validate',
  'process.cancel',
  'process.complete',
  'process.start',
  'process.step.await_gate',
  'process.step.complete',
  'process.step.create',
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

  // Sandbox App Registry
  'retention.sweep',
  'sandbox_app.access_denied',
  'sandbox_app.archive',
  'sandbox_app.create',
  'sandbox_app.export',
  'sandbox_app.preview',
  'sandbox_app.validation_failed',
  'sandbox_app.version.activate',
  'sandbox_app.version.create',

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
