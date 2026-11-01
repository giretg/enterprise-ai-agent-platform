'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MAX_HIRE_CARDS, normalizeHireCards } from '@/lib/agent-hire'

const INPUT = 'w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm'

/**
 * Egyszerű mondat-kártyák listája (feladatok / „Mit NE csináljon”). Példák
 * egy kattintással felvehetők; a sorrend és a szöveg szabadon átírható.
 */
export function HireCardList({
  cards,
  onChange,
  placeholder,
  addLabel,
  examples = [],
  examplesLabel,
  tone = 'do',
  disabled = false,
}: {
  cards: string[]
  onChange: (next: string[]) => void
  placeholder: string
  addLabel: string
  examples?: string[]
  examplesLabel?: string
  tone?: 'do' | 'dont'
  disabled?: boolean
}) {
  const t = useTranslations('AgentCreate')
  const [draft, setDraft] = useState('')
  const full = cards.length >= MAX_HIRE_CARDS
  const unusedExamples = examples.filter(
    (example) => !cards.some((card) => card.toLowerCase() === example.toLowerCase()),
  )

  function add(text: string) {
    const next = normalizeHireCards([...cards, text])
    if (next.length === cards.length) return
    onChange(next)
    setDraft('')
  }

  function update(index: number, text: string) {
    const next = [...cards]
    next[index] = text
    onChange(next)
  }

  function remove(index: number) {
    onChange(cards.filter((_, i) => i !== index))
  }

  const accent =
    tone === 'do' ? 'border-sage/35 bg-sage/8' : 'border-coral/30 bg-coral/6'

  return (
    <div className="space-y-2">
      {cards.length > 0 ? (
        <ol className="space-y-2">
          {cards.map((card, index) => (
            <li key={index} className={`animate-hire-pop flex items-start gap-2 rounded-lg border px-3 py-2 ${accent}`}>
              <span aria-hidden className="mt-1 text-sm">
                {tone === 'do' ? '✓' : '✕'}
              </span>
              <textarea
                value={card}
                rows={1}
                disabled={disabled}
                onChange={(event) => update(index, event.target.value)}
                onBlur={() => onChange(normalizeHireCards(cards))}
                aria-label={t('cardEditAria', { index: index + 1 })}
                className="min-h-[2rem] flex-1 resize-y bg-transparent text-sm text-ink outline-none [field-sizing:content]"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(index)}
                aria-label={t('cardRemoveAria', { index: index + 1 })}
                className="rounded-full px-2 text-sm text-ink-faint hover:text-coral disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {!full ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            add(draft)
          }}
        >
          <input
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            className={INPUT}
          />
          <button
            type="submit"
            disabled={disabled || !draft.trim()}
            className="shrink-0 rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft hover:border-coral/40 hover:text-ink disabled:opacity-50"
          >
            {addLabel}
          </button>
        </form>
      ) : (
        <p className="text-xs text-ink-faint">{t('cardsFull', { max: MAX_HIRE_CARDS })}</p>
      )}
      {unusedExamples.length > 0 && !full ? (
        <div className="space-y-1.5">
          {examplesLabel ? <p className="text-xs text-ink-faint">{examplesLabel}</p> : null}
          <ul className="flex flex-wrap gap-1.5">
            {unusedExamples.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => add(example)}
                  className="rounded-full border border-dashed border-ink/20 px-3 py-1 text-left text-xs text-ink-soft hover:border-coral/40 hover:text-ink disabled:opacity-50"
                >
                  + {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
