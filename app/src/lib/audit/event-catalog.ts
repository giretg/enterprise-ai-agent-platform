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
  'tenant.language.update',
  // Szerepkörönkénti fejléc-menü kurálás (Menü-hozzáférés). A metadata a teljes
  // előtte/utána policy-t hordozza, hogy a döntés visszakereshető legyen.
  'tenant.nav_visibility.update',
  'tenant.oauth.google.update',
  'platform.oauth.google.update',
  'platform.oauth.google_drive.update',
  'platform.oauth.google_drive_picker.update',
  'tenant.self_update.policy.update',
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

  // Agent Registry
  'agent.avatar',
  'agent.activated',
  'agent.api_key_revoked',
  'agent.api_key_rotated',
  'agent.behavior_profile_set',
  'agent.behavior_profile_update_accepted',
  'agent.behavior_profile_updated',
  'agent.create',
  // Provisioning Assistant §13: NL → agent-vázlat javaslat (ember még nem hozott létre agentet).
  'agent.scaffold.propose',
  'agent.delete',
  'agent.dispatch_denied_inactive',
  // Agent-hozzáférési gráf (Access-Policy §agent-scope, #142). A `channel`
  // (chat | agent_ask | ticket | web_research) ADAT a metadatában, nem külön
  // eseménynév — így egy lekérdezés minden úton látja a döntéseket.
  'agent.access.granted',
  'agent.access.denied',
  // A folyamat-motor shadow ellenőrzése: a Playbook/Monitor út ÁTMEGY, de az ad-hoc
  // gráf elutasította volna. Auditál, nem blokkol.
  'agent.access.bypass',
  'agent_access.grant.create',
  'agent_access.grant.revoke',
  'agent_access.restriction.update',
  // Tenant user↔agent kiinduló jogmátrix (minden tag látja/megszólíthatja a tenant agenteket).
  'agent_access.default_grants.materialize',
  // Futás-elemző (#343): admin-only user→agent grantok materializálása. Ez adja a
  // hozzáférést a tenant TELJES napló-forgalmához, ezért külön nyoma van.
  'agent_access.run_analyst_admin_grants.materialize',
  // Tenant admin: agent elrejtése / megjelenítése az operátorok listájából.
  'agent.operator_visibility',
  'agent.persona',
  'agent.resumed',
  'agent.retired',
  'agent.self_evolution_profile_change',
  // Sensitivity router per-agent felmentés ki/bekapcsolása (§4.7.2).
  'agent.sensitivity_policy',
  'agent.suspended',
  // Tenant admin: feladatkör-korlátozás ki/bekapcsolása (#199). UI-egyszerűsítés,
  // nem jogosultsági korlát — az agent képességei változatlanok.
  'agent.task_only',
  'agent.efficiency_hint_applied',
  'agent.efficiency_hint_reverted',
  'agent.version',
  'behavior_profile.created',
  'capability.update',
  // Futás-elemző: a capability-panel system-role miatt elutasított mentése.
  'capability.update_denied_system_role',
  // Futás-elemző napló-olvasás (RA-03…RA-06). Minden run_* hívás egyet ír.
  'analysis.run_index',
  'analysis.run_stats',
  'analysis.run_trace',

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
  'connector.binding.update',
  'connector.self_update.create',
  'connector.self_update.source.approve',
  'connector.self_update.trust.approve',
  'connector.self_update.policy.update',
  'connector.self_update.api_key.rotate',
  'connector.self_update.sync.failed',
  'connector.self_update.sync.no_change',
  'connector.self_update.sync.proposed',
  'connector.self_update.version.approve',
  'connector.self_update.version.auto_approve',
  'connector.self_update.version.reject',
  'connector.self_update.version.rollback',
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
  'provisioning.doc.fetch',
  'provisioning.doc.fetch.blocked',
  'connector.egress_allowlist.extend',

  // ConversationSession
  'context.assembled',
  'context.truncated',
  'conversation.archive',
  'conversation.content_deleted',
  'conversation.create',
  'conversation.debug_log.export',
  'conversation.promote_to_ticket',
  'message.append',
  'message.content_deleted',

  // Model Gateway
  'model.call',
  'model.call.denied',
  'model.call.sensitivity_override',
  // Az agent teljes felmentést kapott a sensitivity-router blokkolása/reroute-ja alól
  // (kategória-policy `allow`, APG-11; a régi boolean overlay deprecated).
  // Az osztályozási auditnyom megmarad.
  'model.call.sensitivity_agent_bypass',
  // A mintaszűrő réteg (külön a tokenizálás OBSERVE-jától) feljegyezte, mit
  // tiltott / terelt volna, de a hívás ment.
  'model.call.sensitivity_observed',
  'sensitivity.layer.mode.set',
  // Napi model-keret (összesített tenant + per-agent) átállítása a tenant admin felületről.
  'model.budget_changed',
  'model.fallback_chain.set',
  'model.structuring.set',
  'model_policy.upsert',
  // Cross-provider tartalék-lánc: a hívás átesett a következő providerre
  // (a `metadata` hordozza a kiesett/átvevő providert és a hiba-osztályt).
  'model.call.fallback',
  // Modell-árazás: a LiteLLM ár-térkép szinkronja, illetve a kézi felülírás
  // beállítása/törlése az admin felületről.
  'model.pricing.sync',
  'model.pricing.manual_set',
  'model.pricing.manual_clear',
  // A globális tartalék-lánc konfigurációjának mentése.
  'model.fallback_chain.set',

  // Tool Broker
  'tool.authorize_denied_orchestrator',
  'tool.call',
  'tool.call.denied',

  // AI Privacy Gateway (APG-09 §13/§15; APG-08 §10.5; APG-02 unknown-álnév).
  // A payload soha nem tartalmazza a nyers entitásértéket — kategória, akció,
  // span-szám, scope; denied/unknown ágon az álnév, nem a nyers érték.
  'privacy.transform.applied',
  'privacy.transform.observed',
  'privacy.transform.failed',
  'privacy.resolve.applied',
  'privacy.resolve.denied',
  'privacy.surrogate.unknown',
  'privacy.catalog.sync.applied',
  'privacy.catalog.sync.failed',
  'privacy.connector.capability.absent',
  'privacy.connector.capability.changed',
  'privacy.gateway.mode.set',
  'privacy.gateway.category_policy.set',
  'privacy.egress.export_resolved',
  'consequence.approval.pending',
  'consequence.approval.approved',
  'consequence.approval.rejected',

  // Delegation
  'delegation.create',
  'delegation.return',

  // Dispatcher
  'dispatch.blocked',
  'dispatch.budget_blocked',
  'dispatch.complete',
  'dispatch.complete.denied',
  'dispatch.error',
  'dispatch.manual',
  'dispatch.notify.failed',
  'dispatch.notify.sent',
  'dispatch.start',
  'dispatch.tenant_inactive',
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
  // Control-plane eval műveletek: a golden set és futási eredmény tenant-/aktor-
  // kötött kormányzási bizonyíték, ezért a létrehozás, futtatás és olvasás is
  // append-only eseményként jelenik meg.
  'training.eval_created',
  'training.eval',
  'training.eval_read',
  'training.proposed',
  'training.approved',
  'training.rejected',
  'training.capability_escalation_denied',
  // Write-gate token életciklus (§9.4) — a következményes memória-írás engedélye
  // és felhasználása a hash-láncban is nyomon követhető, nem csak a token-táblában.
  // A nyers token-érték SOHA nem kerül auditba, csak a token azonosítója.
  'write_gate.issued',
  'write_gate.consumed',
  'write_gate.replay_denied',
  'write_gate.expired',
  // Hamisítás-jelzés: rossz diff-hash, hiányzó horgony vagy hamisított aláírás.
  'write_gate.rejected',
  // Tartós agent-memória (agent-memory-persistent-cross-conversation-spec.md WP-3/WP-4)
  'memory.retrieve',
  'memory.propose',
  // §3.2/§16 S3 — capture-idő content-guard hard-block (detektált secret/kulcs)
  'memory.propose.blocked',
  // Tartós agent-memória — WP-6 (jóváhagyási elágazás, §6.3/§14.1)
  'memory.candidate.modified',
  'memory.candidate.approved',
  'memory.candidate.ticketed',
  'memory.candidate.rejected',
  'memory.chunk.created',
  'memory.chunk.updated',
  'memory.chunk.superseded',
  'memory.chunk.archived',
  'memory.chunk.deleted',
  // Tartós agent-memória — WP-7 (konfliktus-előszűrés, §7/§14.1)
  'memory.conflict_detected',
  // Tartós agent-memória — WP-8 (maintenance/consolidation + rollback, §8.4/§9.3/§14.1)
  'memory.chunk.delete_requested',
  'memory.chunk.demoted',
  'memory.maintenance.started',
  'memory.maintenance.proposed',
  'memory.maintenance.approved',
  'memory.maintenance.rejected',
  'work_project.create',
  'work_project.update',
  'work_project.archive',
  'work_project.unarchive',

  // Knowledge base
  'kb.document.approved',
  'kb.document.deleted',
  'kb.document.rejected',
  'kb.processing_mode.set',
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
  // Legacy: a kill-switch alatti, körönkénti „kihagyva” bejegyzést megszüntettük (minden
  // audit.append globális advisory lockot vesz a hash-láncra, így percenkénti zaj volt).
  // Regisztrálva marad, mert korábbi sorok hivatkoznak rá.
  'monitor.sweep.skipped',
  'monitor.sweep.suppressed',

  // Playbook / process runtime
  'gate.approve',
  'gate.bypass_denied',
  'playbook.approve',
  'playbook.assignment.create',
  'playbook.create',
  'playbook.pack.import',
  'playbook.tenant_default_error_policy.set',
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
  'process.cancel.tickets_closed',
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
  'process.step.human_override',
  'process.step.retry',
  'process.workspace_handoff',
  'contract.evaluate',
  'ticket.comment.add',
  'ticket.comment.attachment.uploaded',
  'ticket.debug_log.export',
  'ticket.delete',
  'ticket.handback',
  'ticket.runas.authorize',
  'ticket.runas.revoke',
  'ticket.transition',
  'ticket.transition.denied',
  'ticket.update',
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
  /** Több-fájlos csomag-import (ZIP/URL): mi jött be és mi maradt ki, tételesen. */
  'skill.package_imported',
  /** Level-2 melléklet betöltése futás közben (a `load_skill` utáni harmadik szint). */
  'skill.attachment_loaded',
  'skill.created',
  'skill.display_name_updated',
  'skill.description_updated',
  'skill.version.proposed',
  'skill.version.reviewed',
  'skill.version.approved',
  'skill.version.agents_migrated',
  'skill.assigned',
  'skill.unassigned',
  'skill.loaded',
  'skill.rolled_back',
  'skill.deactivated',
  'skill.deleted',
  'skill.access_denied',
  'skill.blocked_unready',
  'skill.run_snapshot',
  // issue #161 — `preferredMode: 'task'`: a chat helyett a boardon fut végig.
  'skill.task_promoted',
  /** #375 — a chatből indított feladat végleges eligazítása, amit a felhasználó látott és jóváhagyott. */
  'task.briefing_confirmed',

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
  'web_search.platform_hosted.config_changed',
  'web_search.tenant.config_changed',
  'web_search.tenant.paused',
  'web_search.tenant.resumed',
  'web_search.paused',
  'web_search.resumed',

  // Chat thinking-trace tenant-szintű kapcsoló
  'chat.thinking_trace.enabled',
  'chat.thinking_trace.disabled',
  'chat.thinking_trace.config_changed',

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

  // Csatorna-réteg (Telegram feature-spec #70/#71, D14). A platform-bot regisztráció/
  // frissítés és a kimenő üzenet ki-/blokk-eseményei — a titok NYERSEN sosem kerül
  // auditba, csak a titok-referencia (maga a mutató).
  'channel.bot.register',
  'channel.bot.update',
  // A bejövő webhook bekötése a providernél (`setWebhook`) — a Telegram oldalán ettől kezdve
  // érkeznek hozzánk az üzenetek, ezért állapotváltozásként auditáljuk. A titkos fejléc NYERSEN
  // itt sem szerepel, csak az, hogy be lett-e állítva.
  'channel.bot.webhook_installed',
  'channel.message.sent',
  'channel.message.blocked',
  // Összekötés és visszavonás (#72, D12): token kiadása, kötés létrejötte/elutasítása,
  // visszavonás (saját/admin), és a bekötetlen küldő EGYSZERI semleges válasza. Az
  // azonosítók ÁLNEVESÍTVE (kereső-hash prefix), nyers külső id sosem kerül auditba.
  'channel.link.token_issued',
  'channel.link.established',
  'channel.link.rejected',
  'channel.identity.revoked',
  'channel.link.unlinked_notice',
  // 1:1 agent-chat (#73/#74, D8): a bejövő forduló-sor és a worker-feldolgozás eseményei.
  'channel.turn.enqueued',
  'channel.turn.completed',
  'channel.turn.retry',
  'channel.turn.failed',
  // A #73 szelet korábbi, agent-engedély nélküli útmutató válasza — a #74 óta `turn.completed`
  // alá esik, a konstans visszafelé-kompatibilitásért marad.
  'channel.turn.no_agent',
  // Proaktív értesítés (#77, D7/D11/D15): a Monitor-riasztás a csatorna harmadik bejáratán
  // Telegramra megy. A küldési hiba best-effort (`failed`, a Monitor-futás nem bukik el);
  // a bot-letiltás a kötést `blocked`-ra jelöli (`channel.identity.blocked`), és a küldés
  // abbamarad. Az azonosítók ÁLNEVESÍTVE, nyers külső id sosem kerül auditba.
  'channel.notification.sent',
  'channel.notification.skipped',
  'channel.notification.failed',
  'channel.identity.blocked',
  // Üzemeltetés (#78, D4): a bot SAJÁT kimenő üzeneteinek megőrzési takarítása. Az
  // azonosítók ÁLNEVESÍTVE (kereső-hash prefix / szál-pszeudonim), nyers tartalom sosem.
  'channel.message.purged',
  'channel.retention.swept',
  // Agent-engedélyek, projektkötés és szervezeti kill-switch (#75, D5/D9/D13/D54): az admin
  // agentenként engedélyez/visszavon, a felhasználó projektkulcsot állít, a tenant-admin a
  // szervezeti kapcsolóval azonnal elzárja a csatornát. Azonosítók álnevesítve.
  'channel.agent.granted',
  'channel.agent.revoked',
  'channel.agent.project_set',
  'channel.tenant.disabled',
  'channel.tenant.enabled',
  // Eseményvezérelt jóváhagyás Telegram-gombokkal (#76, D5/D6/D14): a ticket-állapotgép
  // `awaiting_human` eseményére a felelős / jóváhagyói kör jogosultság-tudatos gombokat kap;
  // a koppintás élő jogosultság-ellenőrzés + aláírt, egyszer-használatos payload után a KÖZÖS
  // állapotgépet lépteti. A kapukon elakadt koppintás `rejected`, a kettős koppintás
  // `acknowledged` (nyugtázás, nem hiba). Az azonosítók ÁLNEVESÍTVE, nyers külső id sosem.
  'channel.approval.notified',
  'channel.approval.decided',
  'channel.approval.rejected',
  'channel.approval.acknowledged',

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
