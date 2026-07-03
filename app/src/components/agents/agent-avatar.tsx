import { personaFor, humanStatus } from '@/lib/agent-persona'

const SIZES = {
  sm: { box: 'h-10 w-10', text: 'text-lg', dot: 'h-2.5 w-2.5' },
  md: { box: 'h-14 w-14', text: 'text-2xl', dot: 'h-3 w-3' },
  lg: { box: 'h-20 w-20', text: 'text-4xl', dot: 'h-3.5 w-3.5' },
} as const

/** A living portrait of an agent: an uploaded photo when present, otherwise a
 *  face that gently breathes, with a soul-dot that pulses when they're awake. */
export function AgentAvatar({
  name,
  status = 'active',
  size = 'md',
  avatarUrl,
}: {
  name: string
  status?: string
  size?: keyof typeof SIZES
  avatarUrl?: string | null
}) {
  const persona = personaFor(name)
  const { mood } = humanStatus(status)
  const s = SIZES[size]

  return (
    <div className="relative shrink-0">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={persona.nickname}
          className={`animate-breathe rounded-[36%] object-cover ${s.box}`}
          style={{
            boxShadow:
              'inset 0 2px 6px rgba(255,255,255,0.35), inset 0 -3px 8px rgba(0,0,0,0.18), 0 12px 24px -12px rgba(140,40,64,0.45)',
          }}
        />
      ) : (
        <div
          className={`animate-breathe flex items-center justify-center rounded-[36%] ${s.box} ${s.text}`}
          style={{
            background: `linear-gradient(145deg, ${persona.gradient[0]}, ${persona.gradient[1]})`,
            boxShadow:
              'inset 0 2px 6px rgba(255,255,255,0.35), inset 0 -3px 8px rgba(0,0,0,0.18), 0 12px 24px -12px rgba(140,40,64,0.45)',
          }}
          aria-hidden
        >
          <span className="drop-shadow-sm">{persona.emoji}</span>
        </div>
      )}
      <span
        className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-card ${s.dot} ${
          mood === 'awake' ? 'animate-soul bg-sage' : 'bg-ink-faint'
        }`}
        title={mood === 'awake' ? 'Most épp dolgozik' : 'Kávészünetet tart'}
      />
    </div>
  )
}
