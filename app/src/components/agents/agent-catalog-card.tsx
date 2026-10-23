import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'
import { createAgentWizardContinueHref, isHalfFinishedAgent } from '@/lib/create-agent-wizard'

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
}

/**
 * Munkatárs-kártya a listán és a kezdőlapon: arckép + unpublished jelzés.
 * Félbehagyott felvétel (#957) „Félkész” címkét kap, és adminnak a varázsló
 * megjegyzett lépésére visz vissza.
 */
export async function AgentCatalogCard({
  agent,
  canResumeHire = false,
}: {
  agent: AgentCatalogCardModel
  canResumeHire?: boolean
}) {
  const t = await getTranslations('ControlPlane.agents')
  const persona = personaFor(agent.name)
  const statusLabel = isAgentStatusKey(agent.status) ? t(`status.${agent.status}`) : agent.status
  const halfFinished = isHalfFinishedAgent({
    status: agent.status,
    currentDefinitionVersionId: agent.currentDefinitionVersionId ?? null,
  })
  const href =
    halfFinished && canResumeHire
      ? createAgentWizardContinueHref(agent.id)
      : agent.unpublished
        ? `/control-plane/agents/${agent.id}?section=elesites`
        : `/control-plane/agents/${agent.id}`

  return (
    <Link href={href} className="block h-full">
      <Card className="h-full transition-shadow hover:shadow-[0_10px_28px_-18px_rgba(11,11,12,0.55)]">
        <div className="flex gap-4">
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
              {halfFinished ? (
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
              <p className="mt-1 text-sm text-ink">{agent.description}</p>
            ) : null}
            <p className="mt-1 text-sm text-ink-soft">{statusLabel}</p>
          </div>
        </div>
      </Card>
    </Link>
  )
}
