'use client'

import {
  SKILL_KIND_COPY,
  SKILL_KINDS,
  type SkillKind,
} from '@/lib/skill/skill-kind'

export function SkillKindLegend({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={compact ? 'space-y-1 text-[11px] text-ink-faint' : 'space-y-2 text-xs text-ink-soft'}>
      {SKILL_KINDS.map((kind) => (
        <li key={kind}>
          <span className="font-semibold text-ink">{SKILL_KIND_COPY[kind].label}.</span>{' '}
          {SKILL_KIND_COPY[kind].explanation}
        </li>
      ))}
    </ul>
  )
}

export function SkillKindFields({
  kind,
  onChange,
  isPlatformAdmin,
  disabled = false,
  name = 'skill-kind',
  disableKinds = [],
}: {
  kind: SkillKind
  onChange: (next: { kind: SkillKind }) => void
  isPlatformAdmin: boolean
  disabled?: boolean
  name?: string
  disableKinds?: SkillKind[]
}) {
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-medium text-ink-soft">A képesség fajtája</legend>
      <div className="space-y-2">
        {SKILL_KINDS.map((option) => {
          const locked =
            disableKinds.includes(option) || (option !== 'tenant' && !isPlatformAdmin)
          return (
            <label
              key={option}
              className={`block rounded-lg border px-3 py-2 ${
                kind === option ? 'border-coral/40 bg-coral/5' : 'border-ink-faint/20'
              } ${locked ? 'opacity-60' : ''}`}
            >
              <span className="flex items-start gap-2">
                <input
                  type="radio"
                  name={name}
                  className="mt-1"
                  checked={kind === option}
                  disabled={locked || disabled}
                  onChange={() => onChange({ kind: option })}
                />
                <span>
                  <span className="text-sm font-medium text-ink">{SKILL_KIND_COPY[option].label}</span>
                  {locked ? (
                    <span className="ml-2 text-[11px] text-ink-faint">csak platform-admin</span>
                  ) : null}
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
                    {SKILL_KIND_COPY[option].explanation}
                  </span>
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
