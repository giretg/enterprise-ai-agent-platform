/**
 * #1032 bejövő levél: befogadás (idempotens, `connectorId + messageId`), döntés és végrehajtás
 * (jelzés / platform-chat futás / átadás), kézi műveletek és a futások állapot-egyeztetése.
 * DB- és hálózat-független: a tárolót és a mellékhatásokat a hívó adja.
 */
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import {
  DEFAULT_INBOUND_MAIL_RULE,
  decideInboundAction,
  senderAddress,
  THREAD_RUNS_PER_HOUR,
  type InboundMailAction,
  type InboundMailHeaders,
  type InboundMailProvider,
  type InboundMailRule,
} from './inbound-mail'

export type InboundMailStatus = 'new' | 'claimed' | 'processed' | 'ignored' | 'failed'

export type InboundMailEventRecord = {
  id: string
  tenantId: string
  connectorId: string
  agentId: string | null
  messageId: string
  threadId: string | null
  fromAddress: string
  subject: string
  receivedAt: Date
  status: InboundMailStatus
  action: string
  reason: string | null
  processedBy: string | null
  responsibleUserId: string | null
  conversationId: string | null
  handoffId: string | null
  source: string
  error: string | null
  runStartedAt: Date | null
  createdAt: Date
}

/** A postafiók, és az agent, akinek ez a saját címe. */
export type WatchedMailbox = {
  tenantId: string
  connectorId: string
  provider: InboundMailProvider
  address: string | null
  agent: {
    id: string
    name: string
    /** Élesített definíció (átadáshoz kell). */
    definitionId: string | null
    /** #663 megnevezett jóváhagyó — felelős, ha a szabály nem nevez meg mást. */
    approverUserId: string | null
  } | null
}

export type EventPatch = Partial<
  Pick<InboundMailEventRecord, 'status' | 'action' | 'reason' | 'processedBy' | 'conversationId' | 'handoffId' | 'error' | 'responsibleUserId' | 'runStartedAt'>
>

export interface InboundMailStore {
  insertEvent(input: {
    tenantId: string
    connectorId: string
    agentId: string | null
    mail: InboundMailHeaders
    responsibleUserId: string | null
    source: string
  }): Promise<{ event: InboundMailEventRecord; created: boolean }>
  /** Feltételes állapotváltás: csak ha az esemény a `from` állapotok egyikében van. */
  updateEvent(id: string, patch: EventPatch, from?: readonly InboundMailStatus[]): Promise<boolean>
  claimRun(input: { eventId: string; agentId: string; threadId: string | null; dailyRunLimit: number; now: Date; patch: EventPatch }): Promise<'claimed' | 'unavailable' | 'daily_limit' | 'thread_limit'>
  findEvent(tenantId: string, id: string): Promise<InboundMailEventRecord | null>
  knownMessageIds(connectorId: string, messageIds: string[]): Promise<Set<string>>
  /** Az agent `process` döntésű eseményei `since` óta (a napi keret és a szál-limit). */
  countProcessed(input: { agentId: string; since: Date; threadId?: string | null }): Promise<number>
  loadRule(agentId: string): Promise<InboundMailRule | null>
  /** A tenant platform-agentjeinek címei (agent → agent hurok ellen). */
  platformAddresses(tenantId: string): Promise<Set<string>>
  listClaimed(limit: number): Promise<InboundMailEventRecord[]>
}

export type RunStartResult = { ok: true; conversationId: string } | { ok: false; code: string }
export type RunState = 'running' | 'processed' | 'failed' | 'missing'

export interface InboundMailEffects {
  startRun(input: {
    tenantId: string
    agentId: string
    userId: string
    instructions: string
    mailboxAddress: string
    mail: InboundMailHeaders
    eventId: string
  }): Promise<RunStartResult>
  runState(input: { tenantId: string; agentId: string; userId: string; conversationId: string }): Promise<RunState>
  createHandoff(input: {
    tenantId: string
    fromAgentId: string
    fromAgentName: string
    fromDefinitionId: string
    toUserId: string | null
    toAgentId: string | null
    createdById: string
    mailboxAddress: string
    mail: InboundMailHeaders
    eventId: string
  }): Promise<{ handoffId: string }>
}

export type InboundMailServiceDeps = {
  store: InboundMailStore
  effects: InboundMailEffects
  audit?: AuditSink
  now?: () => Date
}

export type IngestOutcome = { messageId: string; eventId: string; created: boolean; action: InboundMailAction | null; status: InboundMailStatus }

const HOUR_MS = 60 * 60 * 1000

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export class InboundMailService {
  constructor(private readonly deps: InboundMailServiceDeps) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Új levelek befogadása. Ugyanaz a levél másodszor (webhook-ismétlés, polling) nem indít semmit. */
  async ingest(mailbox: WatchedMailbox, mails: InboundMailHeaders[], source: string): Promise<IngestOutcome[]> {
    const outcomes: IngestOutcome[] = []
    if (!mailbox.agent) return outcomes
    const rule = (await this.deps.store.loadRule(mailbox.agent.id)) ?? DEFAULT_INBOUND_MAIL_RULE
    const responsibleUserId = rule.responsibleUserId ?? mailbox.agent.approverUserId
    let platformAddresses: Set<string> | null = null
    for (const mail of mails) {
      const { event, created } = await this.deps.store.insertEvent({
        tenantId: mailbox.tenantId,
        connectorId: mailbox.connectorId,
        agentId: mailbox.agent.id,
        mail,
        responsibleUserId,
        source,
      })
      if (!created) {
        outcomes.push({ messageId: mail.messageId, eventId: event.id, created: false, action: null, status: event.status })
        continue
      }
      platformAddresses ??= await this.deps.store.platformAddresses(mailbox.tenantId)
      const now = this.now()
      const [processedToday, threadRunsLastHour] = rule.mode === 'process'
        ? await Promise.all([
            this.deps.store.countProcessed({ agentId: mailbox.agent.id, since: startOfUtcDay(now) }),
            mail.threadId
              ? this.deps.store.countProcessed({ agentId: mailbox.agent.id, since: new Date(now.getTime() - HOUR_MS), threadId: mail.threadId })
              : Promise.resolve(0),
          ])
        : [0, 0]
      const decision = decideInboundAction({
        rule,
        mail,
        ownAddress: mailbox.address,
        platformAddresses,
        processedToday,
        threadRunsLastHour,
      })
      const status = await this.act(mailbox, rule, event, mail, decision.action, decision.reason, responsibleUserId)
      // A döntés után, hibatűrően: egy audit-hiba ne hagyja feldolgozatlanul a (már rögzített) levelet.
      await writeAudit(this.deps.audit, {
        actorType: 'system',
        action: 'inbound_mail.received',
        targetType: 'inbound_mail_event',
        targetId: event.id,
        policyDecision: decision.action,
        metadata: {
          agentId: mailbox.agent.id,
          connectorId: mailbox.connectorId,
          provider: mailbox.provider,
          source,
          from: senderAddress(mail.from),
          decisionCode: decision.reason,
        },
        tenantId: mailbox.tenantId,
      }).catch((error) => console.error('inbound_mail.audit_failed', error instanceof Error ? error.message : error))
      outcomes.push({ messageId: mail.messageId, eventId: event.id, created: true, action: decision.action, status })
    }
    return outcomes
  }

  private async act(
    mailbox: WatchedMailbox,
    rule: InboundMailRule,
    event: InboundMailEventRecord,
    mail: InboundMailHeaders,
    action: InboundMailAction,
    reason: string | null,
    responsibleUserId: string | null,
  ): Promise<InboundMailStatus> {
    const { store } = this.deps
    const agent = mailbox.agent!
    const address = mailbox.address ?? ''
    if (action === 'ignore') {
      await store.updateEvent(event.id, { status: 'ignored', action, reason, processedBy: 'system' }, ['new'])
      return 'ignored'
    }
    if (action === 'notify') {
      await store.updateEvent(event.id, { action, reason }, ['new'])
      return 'new'
    }
    if (!responsibleUserId) {
      await store.updateEvent(event.id, { action: 'notify', reason: 'no_responsible_user' }, ['new'])
      return 'new'
    }
    if (action === 'handoff') {
      if (!agent.definitionId) {
        await store.updateEvent(event.id, { action: 'notify', reason: 'agent_unpublished' }, ['new'])
        return 'new'
      }
      try {
        const { handoffId } = await this.deps.effects.createHandoff({
          tenantId: mailbox.tenantId,
          fromAgentId: agent.id,
          fromAgentName: agent.name,
          fromDefinitionId: agent.definitionId,
          toUserId: rule.handoffToUserId,
          toAgentId: rule.handoffToAgentId,
          createdById: responsibleUserId,
          mailboxAddress: address,
          mail,
          eventId: event.id,
        })
        await store.updateEvent(event.id, { status: 'processed', action, reason: null, processedBy: 'handoff', handoffId }, ['new'])
        await writeAudit(this.deps.audit, {
          actorType: 'system',
          action: 'inbound_mail.handoff',
          targetType: 'inbound_mail_event',
          targetId: event.id,
          policyDecision: 'allowed',
          metadata: { agentId: agent.id, handoffId, toUserId: rule.handoffToUserId, toAgentId: rule.handoffToAgentId },
          tenantId: mailbox.tenantId,
        })
        return 'processed'
      } catch (error) {
        await store.updateEvent(event.id, { action: 'notify', reason: 'handoff_failed', error: errorText(error) }, ['new'])
        return 'new'
      }
    }
    return this.startRun(mailbox, rule.instructions, event, mail, responsibleUserId, 'agent_run', rule.dailyRunLimit)
  }

  /** Platform-chat futás indítása; sikertelen indításnál „Csak jelezze” marad (a levél nem vész el). */
  private async startRun(
    mailbox: WatchedMailbox,
    instructions: string,
    event: InboundMailEventRecord,
    mail: InboundMailHeaders,
    userId: string,
    processedBy: string,
    dailyRunLimit: number,
  ): Promise<InboundMailStatus> {
    const { store } = this.deps
    const agent = mailbox.agent!
    // Előbb foglalás: két párhuzamos „Feldolgozás most” ne indítson két futást.
    const claimed = await store.claimRun({
      eventId: event.id, agentId: agent.id, threadId: mail.threadId, dailyRunLimit, now: this.now(),
      patch: { status: 'claimed', action: 'process', reason: null, processedBy, responsibleUserId: userId, error: null },
    })
    if (claimed === 'unavailable') return (await store.findEvent(mailbox.tenantId, event.id))?.status ?? event.status
    if (claimed !== 'claimed') {
      await store.updateEvent(event.id, { action: 'notify', reason: claimed }, ['new', 'failed', 'ignored'])
      return event.status
    }
    let result: RunStartResult
    try {
      result = await this.deps.effects.startRun({
        tenantId: mailbox.tenantId,
        agentId: agent.id,
        userId,
        instructions,
        mailboxAddress: mailbox.address ?? '',
        mail,
        eventId: event.id,
      })
    } catch (error) {
      result = { ok: false, code: errorText(error) }
    }
    if (!result.ok) {
      await store.updateEvent(event.id, { status: 'new', action: 'notify', reason: 'run_unavailable', error: result.code }, ['claimed'])
      return 'new'
    }
    await store.updateEvent(event.id, { conversationId: result.conversationId }, ['claimed'])
    await writeAudit(this.deps.audit, {
      actorType: 'system',
      action: 'inbound_mail.run_started',
      targetType: 'inbound_mail_event',
      targetId: event.id,
      policyDecision: 'allowed',
      metadata: { agentId: agent.id, userId, conversationId: result.conversationId, processedBy },
      tenantId: mailbox.tenantId,
    })
    return 'claimed'
  }

  /**
   * „Feldolgozás most”: a felhasználó kifejezett kérése — a feladó-szűrő és a hurok-őr nem
   * állítja meg (ő látta a levelet), a napi keret és a szál-limit igen.
   */
  async processNow(input: {
    mailbox: WatchedMailbox
    eventId: string
    actorUserId: string
  }): Promise<{ ok: true; status: InboundMailStatus } | { ok: false; error: string }> {
    const { mailbox } = input
    const agent = mailbox.agent
    if (!agent) return { ok: false, error: 'Ez a postafiók már nem saját címe egyik munkatársnak sem.' }
    const event = await this.deps.store.findEvent(mailbox.tenantId, input.eventId)
    if (!event || event.connectorId !== mailbox.connectorId) return { ok: false, error: 'A levél nem található.' }
    if (event.status === 'claimed') return { ok: false, error: 'A munkatárs már dolgozik ezen a levélen.' }
    if (event.status === 'processed') return { ok: false, error: 'Ez a levél már fel van dolgozva.' }
    const rule = (await this.deps.store.loadRule(agent.id)) ?? DEFAULT_INBOUND_MAIL_RULE
    if (!rule.instructions.trim()) return { ok: false, error: 'Előbb írd meg a feldolgozási utasítást a munkatárs E-mail beállításainál.' }
    const now = this.now()
    const processedToday = await this.deps.store.countProcessed({ agentId: agent.id, since: startOfUtcDay(now) })
    if (processedToday >= rule.dailyRunLimit) return { ok: false, error: 'A munkatárs elérte a mai feldolgozás-keretet. Holnap újra próbálhatod, vagy emeld a keretet.' }
    if (event.threadId) {
      const threadRuns = await this.deps.store.countProcessed({ agentId: agent.id, since: new Date(now.getTime() - HOUR_MS), threadId: event.threadId })
      if (threadRuns >= THREAD_RUNS_PER_HOUR) return { ok: false, error: 'Ebben a levélváltásban az elmúlt órában már többször dolgozott. Próbáld később.' }
    }
    const userId = rule.responsibleUserId ?? agent.approverUserId ?? input.actorUserId
    const mail: InboundMailHeaders = {
      messageId: event.messageId,
      threadId: event.threadId,
      from: event.fromAddress,
      subject: event.subject,
      receivedAt: event.receivedAt,
      labels: [],
      headers: {},
    }
    const status = await this.startRun(mailbox, rule.instructions, event, mail, userId, `user:${input.actorUserId}`, rule.dailyRunLimit)
    await writeAudit(this.deps.audit, {
      actorType: 'human',
      actorId: input.actorUserId,
      action: 'inbound_mail.manual',
      targetType: 'inbound_mail_event',
      targetId: event.id,
      policyDecision: status === 'claimed' ? 'allowed' : 'failed',
      metadata: { operation: 'process_now', agentId: agent.id, runAs: userId },
      tenantId: mailbox.tenantId,
    })
    if (status !== 'claimed') return { ok: false, error: 'A feldolgozás most nem indult el — a munkatárs vagy a platform-chat nem elérhető a felelős kollégának.' }
    return { ok: true, status }
  }

  /** „Figyelmen kívül” / „Kész” — a jelzés lezárása kézzel. */
  async resolveManually(input: {
    tenantId: string
    eventId: string
    actorUserId: string
    status: 'ignored' | 'processed'
  }): Promise<boolean> {
    const ok = await this.deps.store.updateEvent(
      input.eventId,
      { status: input.status, processedBy: `user:${input.actorUserId}` },
      ['new', 'failed'],
    )
    if (ok) {
      await writeAudit(this.deps.audit, {
        actorType: 'human',
        actorId: input.actorUserId,
        action: 'inbound_mail.manual',
        targetType: 'inbound_mail_event',
        targetId: input.eventId,
        policyDecision: 'updated',
        metadata: { operation: input.status },
        tenantId: input.tenantId,
      })
    }
    return ok
  }

  /** A futó feldolgozások állapotának átvétele a platform-chatből (jóváhagyás után `processed`). */
  async reconcileClaimed(limit = 50, events?: InboundMailEventRecord[]): Promise<{ processed: number; failed: number; running: number }> {
    const rows = events ?? (await this.deps.store.listClaimed(limit))
    const counts = { processed: 0, failed: 0, running: 0 }
    for (const event of rows) {
      if (event.status !== 'claimed' || !event.agentId || !event.responsibleUserId) continue
      if (!event.conversationId) {
        // Indítás közben elhalt (nincs beszélgetés) — 15 perc után visszaadjuk jelzésnek.
        if (this.now().getTime() - (event.runStartedAt ?? event.createdAt).getTime() > 15 * 60_000) {
          await this.deps.store.updateEvent(event.id, { status: 'new', action: 'notify', reason: 'run_unavailable' }, ['claimed'])
        }
        continue
      }
      let state: RunState
      try {
        state = await this.deps.effects.runState({
          tenantId: event.tenantId,
          agentId: event.agentId,
          userId: event.responsibleUserId,
          conversationId: event.conversationId,
        })
      } catch {
        counts.running++
        continue
      }
      if (state === 'running') {
        counts.running++
      } else if (state === 'processed') {
        await this.deps.store.updateEvent(event.id, { status: 'processed' }, ['claimed'])
        counts.processed++
      } else {
        await this.deps.store.updateEvent(
          event.id,
          { status: 'failed', error: state === 'missing' ? 'A beszélgetést törölték.' : 'A feldolgozás hibával leállt.' },
          ['claimed'],
        )
        counts.failed++
      }
    }
    return counts
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
