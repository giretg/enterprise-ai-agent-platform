import Link from 'next/link'
import QRCode from 'qrcode'
import type { UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/auth/types'
import { publicChatSecret, turnstileConfigured } from '@/auth/public-chat-deps'
import { services } from '@/domain/gateway-services'
import { readPublicAssistantConfig, readWidgetDomains, SESSION_RETENTION_DAYS } from '@/domain/public-chat/config'
import { issueTestToken } from '@/domain/public-chat/service'
import type { TranscriptEntry } from '@/domain/public-chat/runtime'
import { prisma } from '@/lib/db'
import { platformChatBudgetDay } from '@/lib/platform-chat-settings'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { settingsRecord } from '@/lib/tenant-settings'
import { Badge } from '@/components/ui/shell'
import { PublicAssistantEditor, type ForwardOption } from '@/components/public-assistant/public-assistant-editor'
import { PublicEmbedGuide } from '@/components/public-assistant/public-embed-guide'
import { PublicKbPanel } from '@/components/public-assistant/public-kb-panel'
import { PublicConversations } from '@/components/public-assistant/public-conversations'
import { PublicUnanswered, type UnansweredGroup } from '@/components/public-assistant/public-unanswered'
import { DeleteAgentButton } from '@/components/agents/delete-agent-button'

const TABS = [
  ['beallitasok', 'Beállítások'],
  ['tudas', 'Nyilvános tudás'],
  ['beepites', 'Beépítés'],
  ['beszelgetesek', 'Beszélgetések'],
  ['kerdesek', 'Megválaszolatlan kérdések'],
] as const
type TabId = (typeof TABS)[number][0]

/** Fejléc-számlálók (D20): a tesztbeszélgetések nélkül. */
async function loadStats(agentId: string, tenantId: string) {
  const now = new Date()
  const since = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000)
  const today = new Date(`${platformChatBudgetDay(now)}T00:00:00Z`)
  const [sessionCount, forwardCount, callbackCount, openSignals, usage] = await Promise.all([
    prisma.publicChatSession.count({ where: { agentId, isTest: false, createdAt: { gte: since } } }),
    prisma.publicChatSession.count({ where: { agentId, isTest: false, handoff: 'forwarded', createdAt: { gte: since } } }),
    prisma.publicChatSession.count({ where: { agentId, isTest: false, handoff: 'callback_requested', createdAt: { gte: since } } }),
    prisma.publicChatSignal.count({ where: { agentId, answeredAt: null, dismissedAt: null } }),
    prisma.publicChatDailyUsage.findUnique({ where: { tenantId_day: { tenantId, day: today } } }),
  ])
  return { sessionCount, forwardCount, callbackCount, openSignals, spentToday: usage ? Number(usage.costUsd) : 0 }
}

function testHrefFor(slug: string, agentId: string): string {
  return `/c/${slug}?t=${encodeURIComponent(issueTestToken(publicChatSecret(), agentId, new Date()))}`
}

/** #1016: a nyilvános ügyfélszolgálati asszisztens oldala — a belső agent-beállítások helyett. */
export async function PublicAssistantPage({
  agentId,
  tenantId,
  role,
  tab: rawTab,
}: {
  agentId: string
  tenantId: string
  role: UserRole
  tab: string | undefined
}) {
  const tab: TabId = TABS.some(([id]) => id === rawTab) ? (rawTab as TabId) : 'beallitasok'
  const canEdit = hasMinimumRole(role, 'operator')
  const isAdmin = hasMinimumRole(role, 'admin')
  const row = await prisma.publicAssistant.findFirst({
    where: { agentId, tenantId },
    include: { agent: { select: { name: true } }, tenant: { select: { settings: true } } },
  })
  if (!row) {
    return <p className="text-sm text-ink-soft">Ennek az asszisztensnek hiányzik a nyilvános profilja.</p>
  }
  const draft = readPublicAssistantConfig(row.draft, row.agent.name)
  const published = row.published ? readPublicAssistantConfig(row.published, row.agent.name) : null
  const reviewNote = typeof settingsRecord(row.draft).reviewNote === 'string' ? String(settingsRecord(row.draft).reviewNote) : null
  const hasUnpublishedChanges = !published || JSON.stringify(published) !== JSON.stringify(draft)
  const { sessionCount, forwardCount, callbackCount, openSignals, spentToday } = await loadStats(agentId, tenantId)
  const budget = (published ?? draft).dailyBudgetUsd
  const status = !published ? (
    <Badge>Piszkozat</Badge>
  ) : row.paused ? (
    <Badge tone="warning">Szüneteltetve</Badge>
  ) : (
    <Badge tone="success">Élesítve</Badge>
  )

  let body: React.ReactNode = null
  if (tab === 'beallitasok') {
    const [policy, gmailConnectors, publicKbs] = await Promise.all([
      services.platformSettings.getModelPolicy(tenantId),
      prisma.connector.findMany({
        where: { tenantId, type: 'gmail', lifecycleState: 'active' },
        select: {
          id: true,
          name: true,
          grants: { where: { status: 'active' }, select: { userId: true, accountLabel: true, user: { select: { name: true, email: true } } } },
        },
      }),
      prisma.connector.findMany({ where: { tenantId, type: 'knowledge_base', publicKb: true }, select: { id: true, name: true } }),
    ])
    const forwardOptions: ForwardOption[] = gmailConnectors.map((c) => ({
      connectorId: c.id,
      connectorName: c.name,
      senders: c.grants.map((g) => ({ userId: g.userId, label: g.accountLabel ?? g.user.email ?? g.user.name ?? g.userId })),
    }))
    const kbLabel = (kb: { id: string; name: string }) =>
      kb.name === `kb:public:${agentId}` ? 'Az asszisztens saját nyilvános tudásbázisa' : kb.name.replace(/^kb:public:.*/, 'Másik asszisztens nyilvános tudásbázisa')
    body = (
      <PublicAssistantEditor
        agentId={agentId}
        initial={draft}
        reviewNote={reviewNote}
        canEdit={canEdit}
        isAdmin={isAdmin}
        isPublished={Boolean(published)}
        hasUnpublishedChanges={hasUnpublishedChanges}
        paused={row.paused}
        models={policy.enabled}
        forwardOptions={forwardOptions}
        publicKbs={publicKbs.map((kb) => ({ id: kb.id, label: kbLabel(kb) }))}
      />
    )
  } else if (tab === 'tudas') {
    const own = await prisma.connector.findFirst({ where: { tenantId, type: 'knowledge_base', publicKb: true, name: `kb:public:${agentId}` } })
    if (!own) {
      body = <p className="text-sm text-ink-soft">Nincs saját nyilvános tudásbázis.</p>
    } else {
      const [documents, copyable] = await Promise.all([
        prisma.document.findMany({ where: { connectorId: own.id }, orderBy: { createdAt: 'desc' }, select: { id: true, filename: true, createdAt: true } }),
        prisma.document.findMany({
          where: { tenantId, extractedText: { not: null }, connector: { publicKb: false, visibility: 'shared' } },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { id: true, filename: true },
        }),
      ])
      body = (
        <PublicKbPanel
          agentId={agentId}
          connectorId={own.id}
          documents={documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
          copyable={copyable}
          canEdit={canEdit && draft.kbConnectorIds.includes(own.id)}
        />
      )
    }
  } else if (tab === 'beepites') {
    const appOrigin = resolvePublicAppOrigin()
    const link = `${appOrigin}/c/${row.slug}`
    body = (
      <PublicEmbedGuide
        agentId={agentId}
        slug={row.slug}
        appOrigin={appOrigin}
        color={(published ?? draft).color}
        qrSvg={await QRCode.toString(link, { type: 'svg', margin: 1, width: 128 })}
        isPublished={Boolean(published)}
        paused={row.paused}
        lastLoaded={row.lastLoadedAt ? { domain: row.lastLoadedDomain, at: row.lastLoadedAt.toISOString() } : null}
        domains={readWidgetDomains(row.tenant.settings)}
        isAdmin={isAdmin}
        turnstileReady={turnstileConfigured()}
        testHref={canEdit ? testHrefFor(row.slug, agentId) : null}
      />
    )
  } else if (tab === 'beszelgetesek') {
    const sessions = canEdit
      ? await prisma.publicChatSession.findMany({
          where: { agentId, tenantId, isTest: false },
          orderBy: { lastActivityAt: 'desc' },
          take: 100,
        })
      : []
    body = canEdit ? (
      <PublicConversations
        agentId={agentId}
        isAdmin={isAdmin}
        retentionDays={SESSION_RETENTION_DAYS}
        rows={sessions.map((s) => ({
          id: s.id,
          visitorId: s.visitorId,
          startedAt: s.createdAt.toISOString(),
          lastActivityAt: s.lastActivityAt.toISOString(),
          handoff: s.handoff,
          handoffContact: s.handoffContact,
          handoffSummary: s.handoffSummary,
          messages: (Array.isArray(s.messages) ? (s.messages as unknown as TranscriptEntry[]) : []).map((m) => ({ role: m.role, content: m.content })),
        }))}
      />
    ) : (
      <p className="text-sm text-ink-soft">A beszélgetéseket operátor vagy adminisztrátor nézheti meg.</p>
    )
  } else {
    const signals = await prisma.publicChatSignal.findMany({
      where: { agentId, tenantId, answeredAt: null, dismissedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    const groups = new Map<string, UnansweredGroup>()
    for (const s of signals) {
      const key = s.groupLabel ?? `q:${s.question.toLowerCase().trim()}`
      const g = groups.get(key)
      if (g) {
        g.count += 1
        if (!g.sources.includes(s.source)) g.sources.push(s.source)
        if (!g.examples.includes(s.question)) g.examples.push(s.question)
        g.answerDraft ??= s.answerDraft
      } else {
        groups.set(key, {
          signalId: s.id,
          label: s.groupLabel ?? s.question,
          count: 1,
          sources: [s.source],
          examples: [s.question],
          answerDraft: s.answerDraft,
          lastAt: s.createdAt.toISOString(),
        })
      }
    }
    body = (
      <PublicUnanswered
        agentId={agentId}
        groups={[...groups.values()].sort((a, b) => b.count - a.count)}
        canEdit={canEdit}
        isAdmin={isAdmin}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Nyilvános ügyfélszolgálati asszisztens</p>
          <h1 className="mt-2 flex items-center gap-3 font-display text-3xl font-semibold">
            {draft.displayName} {status}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Bárki beszélhet vele bejelentkezés nélkül. Csak azt tudja, amit itt megadsz — belső munkatárs memóriájához,
            eszközeihez és tudásbázisához nem fér hozzá.
          </p>
        </div>
        {isAdmin ? <DeleteAgentButton agentId={agentId} agentName={draft.displayName} /> : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          ['Beszélgetés (30 nap)', String(sessionCount)],
          ['Továbbítás', `${forwardCount} e-mail · ${callbackCount} visszahívás`],
          ['Mai keret', `${spentToday.toFixed(2)} / ${budget} USD`],
          ['Megválaszolatlan', String(openSignals)],
        ].map(([k, v]) => (
          <div key={k} className="atelier-card p-3">
            <dt className="text-xs text-ink-soft">{k}</dt>
            <dd className="mt-1 text-lg font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      <nav className="flex flex-wrap gap-2 text-sm">
        {TABS.map(([id, label]) => (
          <Link
            key={id}
            href={`/control-plane/agents/${agentId}?tab=${id}`}
            className={`rounded-full px-3 py-1 ${tab === id ? 'bg-coral text-white' : 'border border-line text-ink-soft'}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {body}
      <p className="text-xs text-ink-faint">Utoljára élesítve: {row.publishedAt ? row.publishedAt.toLocaleString('hu-HU') : 'még soha'}</p>
    </div>
  )
}
