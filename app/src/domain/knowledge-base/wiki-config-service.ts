/**
 * #1075 — agent által javasolt wiki-beállítás.
 *
 * Az agent olvas és javasol (`kb_wiki_config_*`), alkalmazni soha nem tud. A jóváhagyás
 * a wiki kezelőjéé (`WikiConsoleService.authorize` `manage`), a Javaslatok fülön. Jóváhagyáskor
 * a javaslat az élő állapoton újra lefut: a változás és az oldalmozgatások egy tranzakció.
 * Az audit-sorba azonosítók és darabszámok kerülnek, tartalom nem.
 */
import type { Connector, Prisma } from '@prisma/client'
import type { AuditRepository, WikiConfigProposalRow, WikiConfigRepository, WikiRepository } from '@/repositories/interfaces'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { fieldValueMatches } from '@/lib/wiki-metadata'
import { normalizeCategoryPath } from '@/lib/wiki-categories'
import {
  WIKI_COLLECT_MAX_CHARS,
  categoryPathOf,
  configVersionOf,
  configPagesVersionOf,
  diffConfig,
  simulateConfigOperations,
  summarizeSimulation,
  templatesOf,
  type WikiConfigPage,
  type WikiConfigState,
} from '@/lib/wiki-config'
import { WikiConsoleError, wikiKbKind, type WikiConsoleActor, type WikiConsoleService } from './wiki-console-service'
import type { WikiCaller, WikiFailure, WikiOutcome, WikiService } from './wiki-service'

const RECENT_FOR_AGENT = 5
const HISTORY_IN_CONSOLE = 10
const MAX_DECISION_COMMENT = 1000

export type WikiConfigDeps = {
  wiki: Pick<WikiService, 'resolveTarget' | 'wikiIdForConnector' | 'applyConfigChange'>
  wikiConsole: Pick<WikiConsoleService, 'authorize' | 'displayName'>
  wikis: Pick<WikiRepository, 'listPages' | 'appendLog'>
  config: WikiConfigRepository
  agentNames(tenantId: string, ids: string[]): Promise<Map<string, string>>
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

export class WikiConfigError extends Error {
  constructor(readonly code: 'config_conflict' | 'invalid_config_change' | 'proposal_not_pending' | 'conflict') {
    super(code)
    this.name = 'WikiConfigError'
  }
}

export function wikiConfigApprovalPath(connectorId: string, proposalId: string): string {
  return `/control-plane/knowledge/${connectorId}?tab=proposals&proposal=${proposalId}`
}

function nameEditable(connector: Connector): boolean {
  const kind = wikiKbKind(connector)
  return kind !== 'agent' && kind !== 'catalog' && kind !== 'public'
}

export class WikiConfigService {
  constructor(private readonly deps: WikiConfigDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  /** Minden oldal, archivált is: a kategória-üresség és a mezőhasználat ezeket is nézi. */
  private async pagesOf(connectorId: string): Promise<WikiConfigPage[]> {
    const pages = await this.deps.wikis.listPages(connectorId, { status: ['published', 'archived', 'pending_approval'] })
    return pages.map((page) => ({
      id: page.id,
      version: page.version,
      path: page.path,
      category: page.category,
      status: page.status,
      frontmatter: page.frontmatter && typeof page.frontmatter === 'object' && !Array.isArray(page.frontmatter)
        ? (page.frontmatter as Record<string, unknown>)
        : {},
    }))
  }

  private async stateOf(wikiId: string): Promise<WikiConfigState> {
    const state = await this.deps.config.readState(wikiId)
    if (!state) throw new Error('not_found')
    return state
  }

  // -------------------------------------------------------------------------
  // Agent

  async get(caller: WikiCaller, input: { wikiId?: string }): Promise<WikiOutcome> {
    const target = await this.deps.wiki.resolveTarget(caller, input.wikiId, 'read')
    if ('ok' in target) return target
    const { connector, wikiId, scope } = target
    const [state, pages, setting, pending, recent] = await Promise.all([
      this.stateOf(wikiId),
      this.pagesOf(connector.id),
      this.deps.config.agentConfigChanges(wikiId),
      this.deps.config.listProposals(wikiId, { pending: true, limit: 20 }),
      this.deps.config.listProposals(wikiId, { pending: false, agentId: caller.agentId, limit: RECENT_FOR_AGENT }),
    ])
    const names = await this.deps.agentNames(caller.tenantId, [...new Set(pending.map((row) => row.agentId))])
    const counts = new Map<string, number>()
    for (const page of pages) {
      const path = normalizeCategoryPath(page.category)
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    const categoryView = (row: WikiConfigState['categories'][number]) => ({
      key: categoryPathOf(row),
      label: row.name,
      description: row.description,
      order: row.sortOrder,
      collapsed: row.collapsed,
      pageCount: counts.get(categoryPathOf(row)) ?? 0,
      ...(row.linkedConnectorId ? { linkedWiki: true } : {}),
    })
    return {
      ok: true,
      result: {
        configVersion: configVersionOf(state),
        wikiId,
        name: await this.deps.wikiConsole.displayName(connector),
        nameEditable: nameEditable(connector),
        collect: state.collect,
        agentCollect: scope.collectFocus,
        writeMode: scope.writeMode,
        managedCategories: state.managedCategories,
        managedFields: state.managedFields,
        agentConfigChanges: setting ? 'propose' : 'off',
        groups: state.categories.filter((row) => !row.parentKey && !row.linkedConnectorId).map(categoryView),
        categories: state.categories.filter((row) => !!row.parentKey && !row.linkedConnectorId).map((row) => ({
          ...categoryView(row),
          pageSort: row.pageSort,
          template: row.templateKey,
          approval: row.approval,
          reviewCycleDays: row.reviewCycleDays,
          pinned: row.pinnedPages,
          manualOrder: row.pageOrder,
          requiredFields: row.requiredFields,
          requiredSections: row.requiredSections,
        })),
        metadataFields: state.fields.map((field) => ({
          key: field.key,
          label: field.name,
          type: field.type,
          options: field.options,
          help: field.help,
          usedBy: Object.fromEntries(field.options.map((option) => [
            option,
            pages.filter((page) => fieldValueMatches(page.frontmatter[field.key], [option])).length,
          ])),
        })),
        templates: [...templatesOf(state.categories)].map(([id, template]) => ({
          id,
          requiredFields: template.requiredFields,
          requiredSections: template.requiredSections,
          sectionRule: template.sectionRule,
          skeleton: template.templateMd,
        })),
        wikiMd: state.wikiMd,
        pendingProposals: pending.map((row) => ({
          proposalId: row.id,
          createdAt: row.createdAt.toISOString(),
          createdBy: names.get(row.agentId) ?? row.agentId,
          summary: row.note.slice(0, 200),
          approvalPath: wikiConfigApprovalPath(connector.id, row.id),
        })),
        recentProposals: recent.map((row) => ({
          proposalId: row.id,
          status: row.status,
          decidedAt: row.decidedAt?.toISOString() ?? null,
          comment: row.decisionComment,
          cause: row.decisionReason,
        })),
      },
    }
  }

  async propose(
    caller: WikiCaller,
    input: { wikiId?: string; baseConfigVersion: string; operations: unknown[]; note: string; validateOnly?: boolean },
  ): Promise<WikiOutcome> {
    const target = await this.deps.wiki.resolveTarget(caller, input.wikiId, 'write')
    if ('ok' in target) return target
    const { connector, wikiId } = target
    if (!(await this.deps.config.agentConfigChanges(wikiId))) {
      return {
        ok: false,
        code: 'config_changes_disabled',
        details: { hint: 'A wiki admin has to allow agent proposals on the Proposals tab of this wiki. Nothing was created.' },
      }
    }
    const [state, pages] = await Promise.all([this.stateOf(wikiId), this.pagesOf(connector.id)])
    const version = configVersionOf(state)
    if (input.baseConfigVersion !== version) return this.staleFailure(version)
    const simulation = simulateConfigOperations({ state, pages, operations: input.operations, nameEditable: nameEditable(connector) })
    if (!simulation.ok) return this.invalidFailure(simulation.issues)
    if (configVersionOf(simulation.next) === version && simulation.pageChanges.length === 0) {
      return this.invalidFailure([{ index: -1, op: null, code: 'no_changes', message: 'These operations change nothing.' }])
    }
    const report = { summary: summarizeSimulation(state, simulation), warnings: simulation.warnings }
    if (input.validateOnly) return { ok: true, result: { status: 'valid', configVersion: version, ...report } }

    const pendingFailure = (open: WikiConfigProposalRow | null): WikiFailure => ({
      ok: false,
      code: 'proposal_pending',
      details: {
        ...(open ? { proposalId: open.id, approvalPath: wikiConfigApprovalPath(connector.id, open.id) } : {}),
        hint: 'You already have an open proposal for this wiki. Wait for the decision, or withdraw it with kb_wiki_config_withdraw.',
      },
    })
    const open = await this.deps.config.findPendingForAgent(wikiId, caller.agentId)
    if (open) return pendingFailure(open)
    const proposal = await this.deps.config.createProposal({
      wikiId,
      connectorId: connector.id,
      agentId: caller.agentId,
      userId: caller.userId,
      baseConfigVersion: version,
      operations: input.operations as Prisma.InputJsonValue,
      note: input.note.trim(),
    })
    // Párhuzamos beküldés: az egyedi index dönt.
    if (!proposal) return pendingFailure(await this.deps.config.findPendingForAgent(wikiId, caller.agentId))
    await this.audit(connector, caller.tenantId, { agentId: caller.agentId, userId: caller.userId }, 'kb.wiki.config.proposed', wikiId, {
      wikiId,
      proposalId: proposal.id,
      operationCount: input.operations.length,
      pageCount: simulation.pageChanges.length,
    })
    return {
      ok: true,
      result: {
        status: 'awaiting_approval',
        proposalId: proposal.id,
        approvalPath: wikiConfigApprovalPath(connector.id, proposal.id),
        ...report,
      },
    }
  }

  async withdraw(caller: WikiCaller, input: { wikiId?: string; proposalId: string }): Promise<WikiOutcome> {
    const target = await this.deps.wiki.resolveTarget(caller, input.wikiId, 'write')
    if ('ok' in target) return target
    const { connector, wikiId } = target
    const proposal = await this.deps.config.findProposal(input.proposalId)
    // Másik agent javaslata nem létezik a hívónak.
    if (!proposal || proposal.wikiId !== wikiId || proposal.agentId !== caller.agentId) return { ok: false, code: 'not_found' }
    const closed = await this.deps.config.closeProposal(proposal.id, 'withdrawn', { decidedByUserId: null, decidedAt: this.now() })
    if (!closed) return { ok: false, code: 'proposal_not_pending' }
    await this.audit(connector, caller.tenantId, { agentId: caller.agentId, userId: caller.userId }, 'kb.wiki.config.withdrawn', wikiId, { wikiId, proposalId: proposal.id })
    return { ok: true, result: { status: 'withdrawn', proposalId: proposal.id } }
  }

  private staleFailure(currentConfigVersion: string): WikiFailure {
    return {
      ok: false,
      code: 'config_conflict',
      details: { currentConfigVersion, hint: 'The configuration changed. Nothing was created. Call kb_wiki_config_get and propose again on the current state.' },
    }
  }

  private invalidFailure(errors: unknown[]): WikiFailure {
    return { ok: false, code: 'invalid_config_change', details: { errors, hint: 'Nothing was created. Fix every listed operation and call again with the whole list.' } }
  }

  // -------------------------------------------------------------------------
  // Javaslatok fül (ember)

  private async open(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.deps.wikiConsole.authorize(actor, connectorId, 'manage')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    return { connector, wikiId }
  }

  private async openProposal(actor: WikiConsoleActor, connectorId: string, proposalId: string) {
    const opened = await this.open(actor, connectorId)
    const proposal = await this.deps.config.findProposal(proposalId)
    if (!proposal || proposal.wikiId !== opened.wikiId) throw new WikiConsoleError('not_found')
    return { ...opened, proposal }
  }

  /** A fül adatai: a kapcsoló, a wiki fókusza, a nyitott javaslatok és az utolsó döntések. */
  async overview(actor: WikiConsoleActor, connectorId: string) {
    const { wikiId } = await this.open(actor, connectorId)
    const [state, enabled, pending, history] = await Promise.all([
      this.stateOf(wikiId),
      this.deps.config.agentConfigChanges(wikiId),
      this.deps.config.listProposals(wikiId, { pending: true, limit: 50 }),
      this.deps.config.listProposals(wikiId, { pending: false, limit: HISTORY_IN_CONSOLE }),
    ])
    const names = await this.deps.agentNames(actor.tenantId, [...new Set([...pending, ...history].map((row) => row.agentId))])
    const view = (row: WikiConfigProposalRow) => ({
      id: row.id,
      agentName: names.get(row.agentId) ?? null,
      note: row.note,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionComment: row.decisionComment,
      decisionReason: row.decisionReason,
      operationCount: Array.isArray(row.operations) ? row.operations.length : 0,
    })
    return { enabled, collect: state.collect, pending: pending.map(view), history: history.map(view) }
  }

  /** Mi történne most, ha jóváhagynád: mindig az élő állapotból számolva. */
  async review(actor: WikiConsoleActor, connectorId: string, proposalId: string) {
    const { connector, wikiId, proposal } = await this.openProposal(actor, connectorId, proposalId)
    const [state, pages, names] = await Promise.all([
      this.stateOf(wikiId),
      this.pagesOf(connector.id),
      this.deps.agentNames(actor.tenantId, [proposal.agentId]),
    ])
    const operations = Array.isArray(proposal.operations) ? proposal.operations : []
    const simulation = simulateConfigOperations({ state, pages, operations, nameEditable: nameEditable(connector) })
    return {
      id: proposal.id,
      status: proposal.status,
      agentName: names.get(proposal.agentId) ?? null,
      note: proposal.note,
      createdAt: proposal.createdAt.toISOString(),
      decisionComment: proposal.decisionComment,
      decisionReason: proposal.decisionReason,
      stale: configVersionOf(state) !== proposal.baseConfigVersion,
      issues: simulation.issues,
      warnings: simulation.warnings,
      destructive: simulation.destructive,
      diff: diffConfig(state, simulation.next),
      pageChanges: simulation.pageChanges.map(({ path, fromCategory, toCategory, frontmatter }) => ({ path, fromCategory, toCategory, fieldsRewritten: !!frontmatter })),
    }
  }

  async approve(actor: WikiConsoleActor, connectorId: string, proposalId: string) {
    const { connector, wikiId, proposal } = await this.openProposal(actor, connectorId, proposalId)
    if (proposal.status !== 'pending') throw new WikiConfigError('proposal_not_pending')
    const [state, pages] = await Promise.all([this.stateOf(wikiId), this.pagesOf(connector.id)])
    if (configVersionOf(state) !== proposal.baseConfigVersion) await this.failStale(actor, connector, wikiId, proposal.id)
    const operations = Array.isArray(proposal.operations) ? proposal.operations : []
    const simulation = simulateConfigOperations({ state, pages, operations, nameEditable: nameEditable(connector) })
    if (!simulation.ok) {
      // A beállítás nem változott, de az oldalak igen (pl. kiemelt oldal azóta áthelyezve).
      await this.close(actor, connector, wikiId, proposal.id, { decisionReason: 'invalid_config_change' })
      throw new WikiConfigError('invalid_config_change')
    }
    const result = await this.deps.wiki.applyConfigChange({
      tenantId: actor.tenantId,
      userId: actor.userId,
      connector,
      wikiId,
      pages: simulation.pageChanges,
      configPlan: { proposalId: proposal.id, expectedVersion: proposal.baseConfigVersion, expectedPagesVersion: configPagesVersionOf(pages), decidedByUserId: actor.userId, next: simulation.next },
      title: 'Config: agent proposal approved',
      note: proposal.note.slice(0, 500),
    })
    if (!result.ok) {
      if (result.code === 'config_conflict') await this.failStale(actor, connector, wikiId, proposal.id)
      if (result.code === 'proposal_not_pending') throw new WikiConfigError('proposal_not_pending')
      // Egy oldal közben változott: a javaslat függőben marad, újra megpróbálható.
      throw new WikiConfigError('conflict')
    }
    await this.audit(connector, actor.tenantId, { userId: actor.userId }, 'kb.wiki.config.applied', wikiId, {
      wikiId,
      proposalId: proposal.id,
      changeSetId: result.result.changeSetId,
      seq: result.result.seq,
      operationCount: operations.length,
      pageCount: simulation.pageChanges.length,
    })
    return { applied: true, seq: result.result.seq, pages: simulation.pageChanges.length }
  }

  async reject(actor: WikiConsoleActor, connectorId: string, proposalId: string, comment: string | null) {
    const { connector, wikiId, proposal } = await this.openProposal(actor, connectorId, proposalId)
    if (proposal.status !== 'pending') throw new WikiConfigError('proposal_not_pending')
    await this.close(actor, connector, wikiId, proposal.id, { decisionComment: comment?.trim().slice(0, MAX_DECISION_COMMENT) || null })
    return { rejected: true }
  }

  private async failStale(actor: WikiConsoleActor, connector: Connector, wikiId: string, proposalId: string): Promise<never> {
    await this.close(actor, connector, wikiId, proposalId, { decisionReason: 'config_conflict' })
    throw new WikiConfigError('config_conflict')
  }

  private async close(
    actor: WikiConsoleActor,
    connector: Connector,
    wikiId: string,
    proposalId: string,
    decision: { decisionComment?: string | null; decisionReason?: string | null },
  ) {
    const closed = await this.deps.config.closeProposal(proposalId, 'rejected', { decidedByUserId: actor.userId, decidedAt: this.now(), ...decision })
    if (!closed) throw new WikiConfigError('proposal_not_pending')
    await this.deps.wikis.appendLog({
      wikiId,
      op: 'schema',
      title: 'Config: agent proposal rejected',
      note: decision.decisionComment ?? decision.decisionReason ?? null,
      actorUserId: actor.userId,
    })
    await this.audit(connector, actor.tenantId, { userId: actor.userId }, 'kb.wiki.config.rejected', wikiId, {
      wikiId,
      proposalId,
      ...(decision.decisionReason ? { cause: decision.decisionReason } : {}),
    })
  }

  async setEnabled(actor: WikiConsoleActor, connectorId: string, enabled: boolean) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    await this.deps.config.setAgentConfigChanges(wikiId, enabled)
    await this.audit(connector, actor.tenantId, { userId: actor.userId }, 'kb.wiki.config.setting_changed', wikiId, { wikiId, enabled })
    return { enabled }
  }

  /** A wiki élő gyűjtési fókusza; az agent-kötés saját fókuszát ez nem érinti. */
  async setCollect(actor: WikiConsoleActor, connectorId: string, collect: string | null) {
    const { connector, wikiId } = await this.open(actor, connectorId)
    const text = collect?.trim() || null
    if (text && text.length > WIKI_COLLECT_MAX_CHARS) throw new WikiConsoleError('invalid_args')
    await this.deps.config.setCollectFocus(wikiId, text)
    await this.audit(connector, actor.tenantId, { userId: actor.userId }, 'kb.wiki.config.collect_updated', wikiId, { wikiId, collectSet: !!text })
    return { collect: text }
  }

  private async audit(
    connector: Connector,
    tenantId: string,
    who: { agentId?: string; userId: string },
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: who.agentId ? 'agent' : 'human',
        actorId: who.agentId ?? who.userId,
        agentVersion: null,
        action,
        targetType: 'wiki',
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { ...metadata, ...(who.agentId ? { agentId: who.agentId } : {}), userId: who.userId, connectorId: connector.id },
        tenantId,
      }),
    )
  }
}
