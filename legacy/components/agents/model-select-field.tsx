'use client'

import {
  providerModelOptions,
  providerOption,
  type ModelProviderOption,
} from '@/lib/model-providers'

type ModelSelectFieldProps = {
  provider: string
  model: string
  onModelChange: (model: string) => void
  className?: string
  providers?: ModelProviderOption[]
}

export function ModelSelectField({
  provider,
  model,
  onModelChange,
  className = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm',
  providers,
}: ModelSelectFieldProps) {
  const selectedProvider = providerOption(provider, providers)
  const models = providerModelOptions(provider, providers)
  const selectedModel = models.find((m) => m.id === model)

  if (models.length === 0) {
    return (
      <input
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        className={className}
        placeholder={selectedProvider.defaultModel}
      />
    )
  }

  return (
    <div>
      <select
        value={models.some((m) => m.id === model) ? model : selectedProvider.defaultModel}
        onChange={(e) => onModelChange(e.target.value)}
        className={className}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {selectedModel?.description && (
        <p className="mt-1 text-xs text-ink-faint">{selectedModel.description}</p>
      )}
    </div>
  )
}
