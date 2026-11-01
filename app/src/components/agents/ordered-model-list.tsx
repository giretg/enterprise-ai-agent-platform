'use client'

import { modelDisplayName, modelRefKey, type ModelRef } from '@/lib/model-policy'

export function OrderedModelList({
  items,
  canEdit,
  onRemove,
  removeLabel,
}: {
  items: ModelRef[]
  canEdit: boolean
  onRemove: (index: number) => void
  removeLabel: string
}) {
  return (
    <ol className="space-y-1">
      {items.map((ref, i) => (
        <li key={modelRefKey(ref)} className="flex items-center justify-between gap-3 text-sm text-ink">
          <span>
            {i + 1}. {modelDisplayName(ref)}
          </span>
          {canEdit ? (
            <button type="button" className="text-xs text-coral" onClick={() => onRemove(i)}>
              {removeLabel}
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
