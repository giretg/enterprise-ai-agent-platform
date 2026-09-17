import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor } from '@/lib/agent-persona'

/** Beágyazott agent-választó — a bal sín kártyáinak vizuális nyelve, linkként. */
export function EmbedAgentPickerCards({
  agents,
  chatHref,
}: {
  agents: Agent[]
  chatHref: (agentId: string) => string
}) {
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {agents.map((agent) => {
        const persona = personaFor(agent.name, {
          personaNickname: agent.personaNickname,
          personaGreeting: agent.personaGreeting,
        })
        return (
          <li key={agent.id}>
            <Link
              href={chatHref(agent.id)}
              aria-label={`Beszélgetés ${persona.nickname} agenttel`}
              className="block rounded-2xl border border-line bg-gradient-to-br from-card to-card-2 p-3 shadow-sm transition-all hover:-translate-y-px hover:border-[#dbcaa9] hover:shadow-md"
            >
              <div className="flex items-start gap-2.5">
                <AgentAvatar
                  name={agent.name}
                  status={agent.status}
                  size="md"
                  avatarUrl={agent.avatarUrl}
                  personaNickname={agent.personaNickname}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-[15px] font-bold leading-tight text-ink">
                    {persona.nickname}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug italic text-ink-faint">
                    &quot;{persona.greeting}&quot;
                  </p>
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
