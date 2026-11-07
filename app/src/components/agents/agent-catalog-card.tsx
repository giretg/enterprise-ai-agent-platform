import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentProductLinks } from '@/components/agents/agent-product-links'
import { StartPlatformChatLink } from '@/components/agents/start-platform-chat-link'
import { VoiceCallButton } from '@/components/agents/voice-call-button'
import { Card } from '@/components/ui/shell'
import { canStartVoiceCall, readVoiceConfig } from '@/domain/voice/config'
import { personaFor } from '@/lib/agent-persona'
import type { AgentProductLink } from '@/lib/agent-product-links'
import { createAgentWizardContinueHref, isHalfFinishedAgent } from '@/lib/create-agent-wizard'
import { canStartPlatformChat } from '@/lib/platform-chat-href'

const AGENT_STATUS_KEYS = ['draft', 'active', 'suspended', 'retired'] as const
type AgentStatusKey = (typeof AGENT_STATUS_KEYS)[number]

function isAgentStatusKey(status: string): status is AgentStatusKey {
  return (AGENT_STATUS_KEYS as readonly string[]).includes(status)
}

export type AgentCatalogCardModel = {
  id: string
  name: string
  description: string | null
  status: string
  avatarUrl: string | null
  unpublished: boolean
  currentDefinitionVersionId?: string | null
  platformChatEnabled?: boolean
  /** #1016: `public` = nyilvános ügyfélszolgálati asszisztens (saját oldal, nincs varázsló/platform-chat). */
  kind?: string
  /** #1029: az agent saját e-mail címe (ha van). */
  mailboxAddress?: string | null
  /** #1111: a hang-beállítás; a kártyáról csak a belőle számolt igen/nem és a gomb kinézete jut tovább. */
  voiceConfig?: unknown
}

/**
 * Munkatárs-kártya a listán és a kezdőlapon: arckép + unpublished jelzés.
 * Félbehagyott felvétel (#957) „Félkész” címkét kap, és adminnak a varázsló
 * megjegyzett lépésére visz vissza.
 */
export async function AgentCatalogCard({
  agent,
  canResumeHire = false,
  tenantChatEnabled = false,
  productLinks,
}: {
  agent: AgentCatalogCardModel
  canResumeHire?: boolean
  /** Beállítások → Beszélgetés a platformon. Kikapcsolva a kártyán nincs indító gomb. */
  tenantChatEnabled?: boolean
  /** Mini appok, tudásbázis, munkafájlok, ütemezett feladatok: ami ennél a munkatársnál elérhető. */
  productLinks?: AgentProductLink[]
}) {
  const t = await getTranslations('ControlPlane.agents')
  const persona = personaFor(agent.name)
  const statusLabel = isAgentStatusKey(agent.status) ? t(`status.${agent.status}`) : agent.status
  const currentDefinitionVersionId = agent.currentDefinitionVersionId ?? null
  const isPublic = agent.kind === 'public'
  const halfFinished = !isPublic && isHalfFinishedAgent({
    status: agent.status,
    currentDefinitionVersionId,
  })
  const href =
    halfFinished && canResumeHire
      ? createAgentWizardContinueHref(agent.id)
      : agent.unpublished
        ? `/control-plane/agents/${agent.id}?section=elesites`
        : `/control-plane/agents/${agent.id}`
  const showStartChat = !isPublic && canStartPlatformChat({
    tenantEnabled: tenantChatEnabled,
    platformChatEnabled: agent.platformChatEnabled !== false,
    status: agent.status,
    currentDefinitionVersionId,
  })
  const showVoiceCall = canStartVoiceCall({
    kind: agent.kind ?? 'internal',
    voiceConfig: agent.voiceConfig,
    status: agent.status,
    currentDefinitionVersionId,
  })
  const visibleProductLinks = isPublic || halfFinished ? [] : (productLinks ?? [])

  return (
    <Card className="flex h-full flex-col transition-shadow hover:shadow-[0_10px_28px_-18px_rgba(11,11,12,0.55)]">
      <Link href={href} className="flex min-h-0 flex-1 items-start gap-4">
        <AgentAvatar
          name={agent.name}
          status={agent.status}
          avatarUrl={agent.avatarUrl}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              {persona.nickname || agent.name}
            </h2>
            {isPublic ? (
              <span
                title="Bárki beszélhet vele a weboldalon vagy linken, bejelentkezés nélkül."
                className="rounded-full border border-sage/40 bg-sage/15 px-2.5 py-0.5 text-xs font-semibold text-ink"
              >
                Nyilvános asszisztens
              </span>
            ) : halfFinished ? (
              <span
                title={t('halfFinishedHint')}
                className="rounded-full border border-sky/50 bg-sky/15 px-2.5 py-0.5 text-xs font-semibold text-ink"
              >
                {t('halfFinished')}
              </span>
            ) : agent.unpublished ? (
              <span
                title={t('unpublishedHint')}
                className="rounded-full border border-amber-600/50 bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-ink"
              >
                {t('unpublished')}
              </span>
            ) : null}
          </div>
          {agent.description ? (
            <p className="mt-1 line-clamp-3 text-sm text-ink-soft">{agent.description}</p>
          ) : null}
          {/* Aktív munkatársnál a zöld pötty elmondja, csak az eltérő állapot kap szöveget. */}
          {isPublic || agent.status === 'active' ? null : <p className="mt-1 text-sm text-ink-soft">{statusLabel}</p>}
          {agent.mailboxAddress ? (
            <p className="mt-1 truncate text-xs text-ink-soft" title="A munkatárs saját e-mail címe">
              ✉ {agent.mailboxAddress}
            </p>
          ) : null}
        </div>
      </Link>
      {showStartChat || showVoiceCall || visibleProductLinks.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {showStartChat ? <StartPlatformChatLink agentId={agent.id} agentName={agent.name} /> : null}
          {showVoiceCall ? <VoiceCallButton agentId={agent.id} agentName={agent.name} callStyle={readVoiceConfig(agent.voiceConfig).callStyle} provider={readVoiceConfig(agent.voiceConfig).provider} /> : null}
          <AgentProductLinks agentName={agent.name} links={visibleProductLinks} className="ml-auto" />
        </div>
      ) : null}
    </Card>
  )
}
