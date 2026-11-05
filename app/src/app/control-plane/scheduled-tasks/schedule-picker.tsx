'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { previewScheduleAction } from '@/app/actions/scheduled-task'
import { SCHEDULE_MODES, defaultOnceDate, scheduleFromForm, type ScheduleForm, type ScheduleMode } from '@/domain/scheduled-task/schedule-form'
import { formatRunTime } from '@/i18n/format'

const WEEK = [1, 2, 3, 4, 5, 6, 0] as const
const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12]
const input = 'w-full rounded-md border border-ink/20 bg-white p-2'

type Preview = { description: string; runsPerDay: number | null; nextRuns: string[]; error: string | null }

function timezoneOptions(current: string): string[] {
  const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Europe/Budapest']
  return [...new Set([current, 'Europe/Budapest', ...known])]
}

/** Gyakoriság + időpont emberi nyelven, élő előnézettel; a cron csak az „Egyedi” módban látszik. */
export function SchedulePicker({ form, timezone, allowOnce, onChange, onTimezone, onValidity }: {
  form: ScheduleForm
  timezone: string
  allowOnce: boolean
  onChange: (next: ScheduleForm) => void
  onTimezone: (next: string) => void
  onValidity: (valid: boolean) => void
}) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const locale = useLocale()
  const value = useMemo(() => scheduleFromForm(form), [form])
  const key = JSON.stringify(value)
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!value) {
      onValidity(false)
      return
    }
    const timer = setTimeout(async () => {
      const result = await previewScheduleAction({ ...value, timezone }).catch(() => null)
      if (cancelled || !result?.success) return
      setPreview(result.data)
      onValidity(!result.data.error)
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` a `key`-ből következik, az onValidity nem indít újra előnézetet.
  }, [key, timezone])

  const modes = SCHEDULE_MODES.filter((mode) => allowOnce || mode !== 'once')
  function pickMode(mode: ScheduleMode) {
    onChange({
      ...form,
      mode,
      ...(mode === 'once' ? { date: defaultOnceDate(form.time, timezone) } : {}),
      // Az „Egyedi” az eddig összekattintott ütemezésből indul.
      ...(mode === 'custom' && value && 'cron' in value ? { cron: value.cron } : {}),
    })
  }
  const timeField = (
    <label className="block text-sm text-ink-soft">{t('picker.time')}
      <input type="time" required className={input} value={form.time} onChange={(event) => onChange({ ...form, time: event.target.value })} />
    </label>
  )

  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{t('when')}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('picker.frequency')}>
        {modes.map((mode) => (
          <label key={mode} className={`cursor-pointer rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 ${form.mode === mode ? 'border-ink bg-ink text-white' : 'border-ink/20'}`}>
            <input type="radio" name={`schedule-mode-${allowOnce}`} className="sr-only" checked={form.mode === mode} onChange={() => pickMode(mode)} />
            {t(`picker.modes.${mode}`)}
          </label>
        ))}
      </div>
      {!allowOnce ? <p className="text-xs text-ink-faint">{t('picker.onceNotShared')}</p> : null}

      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        {form.mode === 'once' ? (
          <>
            <label className="block text-sm text-ink-soft">{t('picker.date')}
              <input type="date" required className={input} value={form.date} onChange={(event) => onChange({ ...form, date: event.target.value })} />
            </label>
            {timeField}
          </>
        ) : null}
        {form.mode === 'daily' || form.mode === 'weekdays' ? timeField : null}
        {form.mode === 'weekly' ? (
          <>
            <div className="text-sm text-ink-soft sm:col-span-2">
              <span id="schedule-days">{t('picker.days')}</span>
              <div className="mt-1 flex flex-wrap gap-1" role="group" aria-labelledby="schedule-days">
                {WEEK.map((day) => {
                  const checked = form.days.includes(day)
                  return (
                    <label key={day} className={`cursor-pointer rounded-md border px-3 py-2 has-[:focus-visible]:ring-2 ${checked ? 'border-ink bg-ink text-white' : 'border-ink/20 text-ink'}`}>
                      <input type="checkbox" className="sr-only" checked={checked} onChange={() => onChange({ ...form, days: checked ? form.days.filter((row) => row !== day) : [...form.days, day] })} />
                      {t(`picker.weekdays.${day}`)}
                    </label>
                  )
                })}
              </div>
            </div>
            {timeField}
          </>
        ) : null}
        {form.mode === 'monthly' ? (
          <>
            <label className="block text-sm text-ink-soft">{t('picker.dayOfMonth')}
              <select className={input} value={form.dayOfMonth} onChange={(event) => onChange({ ...form, dayOfMonth: Number(event.target.value) })}>
                {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{t('picker.dayOption', { day })}</option>)}
              </select>
            </label>
            {timeField}
            {form.dayOfMonth > 28 ? <p className="text-xs text-ink-faint sm:col-span-2">{t('picker.shortMonthNote')}</p> : null}
          </>
        ) : null}
        {form.mode === 'hourly' ? (
          <>
            <label className="block text-sm text-ink-soft">{t('picker.everyHours')}
              <select className={input} value={form.everyHours} onChange={(event) => onChange({ ...form, everyHours: Number(event.target.value) })}>
                {[...new Set([...EVERY_HOURS, form.everyHours])].sort((a, b) => a - b).map((hours) => <option key={hours} value={hours}>{t('picker.everyHoursOption', { hours })}</option>)}
              </select>
            </label>
            <label className="block text-sm text-ink-soft">{t('picker.minute')}
              <select className={input} value={form.minute} onChange={(event) => onChange({ ...form, minute: Number(event.target.value) })}>
                {[...new Set([0, 15, 30, 45, form.minute])].sort((a, b) => a - b).map((minute) => <option key={minute} value={minute}>{t('picker.minuteOption', { minute })}</option>)}
              </select>
            </label>
          </>
        ) : null}
        {form.mode === 'custom' ? (
          <label className="block text-sm text-ink-soft sm:col-span-2">{t('picker.cron')}
            <input className={`${input} font-mono`} value={form.cron} placeholder="0 8 * * 1-5" onChange={(event) => onChange({ ...form, cron: event.target.value })} />
            <span className="mt-1 block text-xs text-ink-faint">{t('picker.cronHint')}</span>
          </label>
        ) : null}
      </div>

      <label className="block max-w-xl text-sm text-ink-soft">{t('timezone')}
        <select className={input} value={timezone} onChange={(event) => onTimezone(event.target.value)}>
          {timezoneOptions(timezone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select>
      </label>

      <div role="status" className="max-w-xl rounded-lg bg-ink/5 p-3 text-sm">
        {!value ? <p className="text-red-800">{t(form.mode === 'weekly' ? 'picker.pickDay' : 'picker.pickTime')}</p>
          : preview?.error ? <p className="text-red-800">{t(`scheduleErrors.${preview.error as 'invalid_args'}`)}</p>
            : preview ? (
              <>
                <p className="font-medium">{preview.description}{preview.runsPerDay ? ` ${t('runsPerDay', { count: preview.runsPerDay })}` : ''}</p>
                {preview.nextRuns.length ? (
                  <p className="mt-1 text-ink-soft">{t('picker.nextRuns')} {preview.nextRuns.map((run) => formatRunTime(run, locale, timezone)).join(' · ')}</p>
                ) : null}
              </>
            ) : <p className="text-ink-soft">{t('picker.checking')}</p>}
      </div>
    </fieldset>
  )
}
