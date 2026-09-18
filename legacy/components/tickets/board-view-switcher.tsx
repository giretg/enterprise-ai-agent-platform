'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export type BoardView = 'kanban' | 'list'

const VIEW_OPTIONS: { value: BoardView; label: string; hint: string }[] = [
  { value: 'kanban', label: 'Kanban', hint: 'Oszlopok között húzható kártyanézet' },
  { value: 'list', label: 'Lista', hint: 'Státusz szerinti táblázatnézet' },
]

export function BoardViewSwitcher({ currentView }: { currentView: BoardView }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setView = (view: BoardView) => {
    const params = new URLSearchParams(searchParams.toString())
    if (view === 'kanban') params.delete('view')
    else params.set('view', view)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <div
      className="inline-flex rounded-full border border-line bg-night-2 p-1"
      role="tablist"
      aria-label="Board nézet"
    >
      {VIEW_OPTIONS.map((option) => {
        const active = currentView === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={option.hint}
            onClick={() => setView(option.value)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              active
                ? 'bg-coral/15 text-coral-deep shadow-sm'
                : 'text-ink-soft hover:bg-coral/8 hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
