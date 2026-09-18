'use client'

import { useEffect, useState } from 'react'
import { listWorkProjects } from '@/app/actions/work-projects'
import {
  GENERAL_WORK_PROJECT_KEY,
  GENERAL_WORK_PROJECT_NAME,
  assignableWorkProjectOptions,
} from '@/lib/work-project'

export type WorkProjectOption = {
  key: string
  name: string
}

const GENERAL_OPTION: WorkProjectOption = {
  key: GENERAL_WORK_PROJECT_KEY,
  name: GENERAL_WORK_PROJECT_NAME,
}

export function WorkProjectSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  label = 'Projekt',
  compact = false,
}: {
  id?: string
  value: string
  options: WorkProjectOption[]
  onChange: (key: string) => void
  disabled?: boolean
  label?: string
  compact?: boolean
}) {
  const shown = options.some((option) => option.key === value)
    ? options
    : value
      ? [{ key: value, name: value }, ...options]
      : options

  return (
    <div className={compact ? 'flex min-w-0 flex-1 items-center gap-2 sm:flex-none sm:min-w-[12rem]' : ''}>
      <label
        htmlFor={id}
        className={compact ? 'shrink-0 text-xs font-medium text-ink-soft' : 'text-sm font-medium text-ink-soft'}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled || shown.length === 0}
        title="Ettől a kerettől függnek az emlékek és a projektleírás az agent számára."
        onChange={(event) => onChange(event.target.value)}
        className={
          compact
            ? 'min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink disabled:opacity-50'
            : 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink disabled:opacity-50'
        }
      >
        {shown.map((option) => (
          <option key={option.key} value={option.key}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/** A tenanthoz tartozó, nem archivált projektek — Általános mindig az első. */
export function AssignableWorkProjectSelect({
  id,
  value,
  onChange,
  disabled,
  label,
  compact = false,
}: {
  id?: string
  value: string
  onChange: (key: string) => void
  disabled?: boolean
  label?: string
  compact?: boolean
}) {
  const [options, setOptions] = useState<WorkProjectOption[]>([GENERAL_OPTION])

  useEffect(() => {
    let cancelled = false
    void listWorkProjects().then((res) => {
      if (cancelled || !res.success) return
      const next = assignableWorkProjectOptions(res.data)
      setOptions(next.length > 0 ? next : [GENERAL_OPTION])
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <WorkProjectSelect
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      label={label}
      compact={compact}
    />
  )
}
