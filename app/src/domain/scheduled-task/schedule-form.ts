import { localDateTime, parseCron } from './cron'

/**
 * Az időzítő űrlap állapota és a cron közti átjárás. Tiszta logika, a böngészőben is fut:
 * a user gyakoriságot és időpontot választ, a cron csak az „Egyedi” módban látszik.
 */
export const SCHEDULE_MODES = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'custom'] as const
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

export type ScheduleForm = {
  mode: ScheduleMode
  /** Egyszeri futás napja: YYYY-MM-DD. */
  date: string
  /** HH:mm */
  time: string
  /** 0 = vasárnap … 6 = szombat */
  days: number[]
  dayOfMonth: number
  everyHours: number
  minute: number
  cron: string
}

export type ScheduleValue = { cron: string } | { runOnceAt: string }

const pad = (value: number) => String(value).padStart(2, '0')
const time = (hour: string | number, minute: string | number) => `${pad(Number(hour))}:${pad(Number(minute))}`

function addDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

/** A legközelebbi nap, amelyiken az adott időpont még nem múlt el. */
export function defaultOnceDate(timeOfDay: string, timezone: string, now = new Date()): string {
  const [today, current] = localDateTime(now, timezone).split('T')
  return timeOfDay > current ? today : addDay(today)
}

export function formFromSchedule(input: { cron: string; runOnceLocal?: string | null; timezone: string }, now = new Date()): ScheduleForm {
  const base: ScheduleForm = { mode: 'custom', date: '', time: '08:00', days: [1], dayOfMonth: 1, everyHours: 1, minute: 0, cron: input.cron }
  if (input.runOnceLocal) {
    const [date, at] = input.runOnceLocal.split('T')
    return { ...base, mode: 'once', date, time: at }
  }
  const form = { ...base, date: defaultOnceDate(base.time, input.timezone, now) }
  if (!parseCron(input.cron)) return form
  const fields = input.cron.trim().split(/\s+/)
  const [minute, hour, dom, month, dow] = fields
  if (month !== '*' || !/^\d+$/.test(minute)) return form
  if (dom === '*' && dow === '*' && (hour === '*' || /^\*\/\d+$/.test(hour))) {
    return { ...form, mode: 'hourly', minute: Number(minute), everyHours: hour === '*' ? 1 : Number(hour.slice(2)) }
  }
  if (!/^\d+$/.test(hour)) return form
  const at = time(hour, minute)
  const withDate = { ...form, time: at, date: defaultOnceDate(at, input.timezone, now) }
  if (dom === '*' && dow === '*') return { ...withDate, mode: 'daily' }
  if (dom === '*' && dow === '1-5') return { ...withDate, mode: 'weekdays' }
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) return { ...withDate, mode: 'weekly', days: dow.split(',').map(Number) }
  if (/^\d+$/.test(dom) && dow === '*') return { ...withDate, mode: 'monthly', dayOfMonth: Number(dom) }
  return form
}

/** `null`: az űrlap még hiányos (nincs nap vagy időpont). */
export function scheduleFromForm(form: ScheduleForm): ScheduleValue | null {
  if (form.mode === 'custom') return form.cron.trim() ? { cron: form.cron.trim() } : null
  if (form.mode === 'hourly') return { cron: `${form.minute} ${form.everyHours === 1 ? '*' : `*/${form.everyHours}`} * * *` }
  const match = /^(\d{2}):(\d{2})$/.exec(form.time)
  if (!match) return null
  if (form.mode === 'once') return /^\d{4}-\d{2}-\d{2}$/.test(form.date) ? { runOnceAt: `${form.date}T${form.time}` } : null
  const at = `${Number(match[2])} ${Number(match[1])}`
  if (form.mode === 'daily') return { cron: `${at} * * *` }
  if (form.mode === 'weekdays') return { cron: `${at} * * 1-5` }
  if (form.mode === 'monthly') return { cron: `${at} ${form.dayOfMonth} * *` }
  if (!form.days.length) return null
  return { cron: `${at} * * ${[...new Set(form.days)].sort((a, b) => a - b).join(',')}` }
}
