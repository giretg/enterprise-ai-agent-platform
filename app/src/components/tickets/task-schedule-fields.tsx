'use client'

import {
  TICKET_SCHEDULE_RECURRENCE_LABELS,
  defaultScheduleLocalDateTime,
  localDateTimeToIso,
  type TicketScheduleRecurrence,
} from '@/lib/ticket-schedule'

export type TaskScheduleMode = 'none' | 'once' | 'recurring'

export type TaskScheduleState = {
  mode: TaskScheduleMode
  runAtLocal: string
  recurrence: TicketScheduleRecurrence
  intervalHours: string
  maxRuns: string
}

export const EMPTY_TASK_SCHEDULE: TaskScheduleState = {
  mode: 'none',
  runAtLocal: '',
  recurrence: 'daily',
  intervalHours: '1',
  maxRuns: '',
}

export type BoardTicketScheduleInput = {
  scheduleMode: TaskScheduleMode
  runAt?: string
  recurrence?: TicketScheduleRecurrence
  intervalHours?: number
  maxRuns?: number | null
}

export function validateTaskSchedule(state: TaskScheduleState): string | null {
  if (state.mode === 'none') return null
  if (!state.runAtLocal.trim()) {
    return state.mode === 'once'
      ? 'Add meg, mikor induljon a feladat.'
      : 'Add meg az első futás időpontját.'
  }
  if (!localDateTimeToIso(state.runAtLocal)) return 'Érvénytelen időpont.'
  if (state.mode === 'recurring' && state.recurrence === 'hourly') {
    const hours = Number(state.intervalHours)
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      return 'Az óra-köz az 1 és 168 óra között legyen.'
    }
  }
  if (state.mode === 'recurring' && state.maxRuns.trim()) {
    const maxRuns = Number(state.maxRuns)
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 365) {
      return 'A futások száma 1 és 365 között legyen.'
    }
  }
  return null
}

export function taskScheduleToInput(state: TaskScheduleState): BoardTicketScheduleInput | null {
  if (state.mode === 'none') return { scheduleMode: 'none' }
  const runAt = localDateTimeToIso(state.runAtLocal)
  if (!runAt) return null
  if (state.mode === 'once') {
    return { scheduleMode: 'once', runAt }
  }
  const maxRunsRaw = state.maxRuns.trim()
  const maxRuns = maxRunsRaw ? Number(maxRunsRaw) : null
  return {
    scheduleMode: 'recurring',
    runAt,
    recurrence: state.recurrence,
    ...(state.recurrence === 'hourly'
      ? { intervalHours: Number(state.intervalHours) || 1 }
      : {}),
    maxRuns: Number.isInteger(maxRuns) ? maxRuns : null,
  }
}

const MODE_OPTIONS: { value: TaskScheduleMode; label: string }[] = [
  { value: 'none', label: 'Nincs' },
  { value: 'once', label: 'Konkrét időpont' },
  { value: 'recurring', label: 'Rendszeres' },
]

export function TaskScheduleFields({
  state,
  disabled,
  onChange,
}: {
  state: TaskScheduleState
  disabled?: boolean
  onChange: (next: TaskScheduleState) => void
}) {
  const setMode = (mode: TaskScheduleMode) => {
    onChange({
      ...state,
      mode,
      runAtLocal:
        mode === 'none'
          ? state.runAtLocal
          : state.runAtLocal || defaultScheduleLocalDateTime(1),
    })
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-ink-soft">Ütemezés</legend>
      <p className="text-xs text-ink-faint">
        {state.mode === 'recurring'
          ? 'Ez a kártya a sorozat marad a következő időponttal. Futáskor új példány készül az aznapi dátummal — az megy készbe.'
          : 'Ha időpontot adsz meg, a feladat azonnal megjelenik a táblán, de a feldolgozás csak akkor indul.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => setMode(option.value)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition disabled:opacity-50 ${
              state.mode === option.value
                ? 'border-honey/50 bg-honey/10 text-ink'
                : 'border-line text-ink-soft hover:border-honey/30'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {state.mode === 'once' && (
        <label className="block">
          <span className="text-sm font-medium text-ink-soft">Mikor induljon</span>
          <input
            type="datetime-local"
            value={state.runAtLocal}
            disabled={disabled}
            onChange={(e) => onChange({ ...state, runAtLocal: e.target.value })}
            className="mt-1 w-full max-w-xs rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          />
        </label>
      )}

      {state.mode === 'recurring' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-ink-soft">Gyakoriság</span>
            <select
              value={state.recurrence}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...state,
                  recurrence: e.target.value as TicketScheduleRecurrence,
                })
              }
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            >
              <option value="monthly">{TICKET_SCHEDULE_RECURRENCE_LABELS.monthly}</option>
              <option value="weekly">{TICKET_SCHEDULE_RECURRENCE_LABELS.weekly}</option>
              <option value="daily">{TICKET_SCHEDULE_RECURRENCE_LABELS.daily}</option>
              <option value="hourly">meghatározott óránként</option>
            </select>
          </label>

          {state.recurrence === 'hourly' && (
            <label className="block">
              <span className="text-sm font-medium text-ink-soft">Hány óránként</span>
              <input
                type="number"
                min={1}
                max={168}
                value={state.intervalHours}
                disabled={disabled}
                onChange={(e) => onChange({ ...state, intervalHours: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
              />
            </label>
          )}

          <label className="block">
            <span className="text-sm font-medium text-ink-soft">Első futás</span>
            <input
              type="datetime-local"
              value={state.runAtLocal}
              disabled={disabled}
              onChange={(e) => onChange({ ...state, runAtLocal: e.target.value })}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-ink-soft">
              Legfeljebb ennyi alkalom{' '}
              <span className="font-normal text-ink-faint">(opcionális)</span>
            </span>
            <input
              type="number"
              min={1}
              max={365}
              placeholder="korlátlan"
              value={state.maxRuns}
              disabled={disabled}
              onChange={(e) => onChange({ ...state, maxRuns: e.target.value })}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>
      )}
    </fieldset>
  )
}
