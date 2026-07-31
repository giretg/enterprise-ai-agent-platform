'use client'

import { MODEL_TYPES, type ModelType } from '@/lib/model-providers'

type ModelTypeSelectFieldProps = {
  modelType: ModelType
  onModelTypeChange: (modelType: ModelType) => void
  className?: string
}

export function ModelTypeSelectField({
  modelType,
  onModelTypeChange,
  className = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm',
}: ModelTypeSelectFieldProps) {
  const selected = MODEL_TYPES.find((t) => t.id === modelType)

  return (
    <div>
      <select
        value={modelType}
        onChange={(e) => onModelTypeChange(e.target.value as ModelType)}
        className={className}
      >
        {MODEL_TYPES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      {selected?.description && (
        <p className="mt-1 text-xs text-ink-faint">{selected.description}</p>
      )}
    </div>
  )
}
