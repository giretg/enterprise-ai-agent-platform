import type { Agent } from '../types'
import { getPersona, humanStatus } from '../agent-persona'

const sizes = {
  sm: { box: 36, emoji: 'text-lg', ring: 2 },
  md: { box: 52, emoji: 'text-2xl', ring: 2.5 },
  lg: { box: 76, emoji: 'text-4xl', ring: 3 },
  xl: { box: 104, emoji: 'text-5xl', ring: 3.5 },
}

/**
 * A munkatárs arca. Lágy színátmenet, lélegző mozgás és egy élő "lélek"-pont,
 * ami a hangulatát mutatja.
 */
export function AgentAvatar({
  agent,
  size = 'md',
  showSoul = true,
}: {
  agent: Pick<Agent, 'id' | 'name' | 'status'>
  size?: keyof typeof sizes
  showSoul?: boolean
}) {
  const persona = getPersona(agent)
  const mood = humanStatus(agent.status)
  const s = sizes[size]

  return (
    <div className="relative shrink-0" style={{ width: s.box, height: s.box }}>
      <div
        className="animate-breathe flex h-full w-full items-center justify-center rounded-[34%]"
        style={{
          background: `radial-gradient(120% 120% at 30% 25%, ${persona.gradient[0]}, ${persona.gradient[1]})`,
          boxShadow: `0 8px 22px -8px ${persona.gradient[1]}88, inset 0 2px 6px rgba(255,255,255,0.35), inset 0 -6px 12px rgba(0,0,0,0.18)`,
        }}
      >
        <span className={`${s.emoji} drop-shadow-sm`} aria-hidden>
          {persona.emoji}
        </span>
      </div>
      {showSoul && (
        <span
          className="animate-soul absolute -bottom-0.5 -right-0.5 rounded-full"
          aria-hidden
          style={{
            width: s.ring * 4,
            height: s.ring * 4,
            background: mood.dot,
            color: mood.dot,
            border: '2px solid var(--color-card)',
          }}
        />
      )}
    </div>
  )
}
