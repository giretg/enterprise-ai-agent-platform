'use client'

import type { InstallerPlatform } from '@/domain/client-policy/installer-filename'

export function InstallerOsField({
  name,
  value,
  onChange,
  legend,
  posixLabel,
  windowsLabel,
}: {
  name: string
  value: InstallerPlatform
  onChange: (platform: InstallerPlatform) => void
  legend: string
  posixLabel: string
  windowsLabel: string
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-ink">{legend}</legend>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {([
          ['posix', posixLabel],
          ['windows', windowsLabel],
        ] as const).map(([platform, label]) => (
          <label
            key={platform}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-line p-3 has-checked:border-coral/50"
          >
            <input
              type="radio"
              name={name}
              value={platform}
              checked={value === platform}
              onChange={() => onChange(platform)}
              className="accent-coral"
            />
            <span className="text-sm font-semibold text-ink">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
