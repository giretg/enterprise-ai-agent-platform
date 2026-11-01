'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  createScheduledTaskAction, inviteScheduledTaskMembersAction, listRunToolCallsAction, previewScheduleAction, respondScheduledTaskAction, updateScheduledTaskAction,
  type ScheduledTaskFormOptions, type ScheduledTaskRow,
} from '@/app/actions/scheduled-task'
import { formatDateTime } from '@/i18n/format'
import { Badge } from '@/components/ui/shell'
import type { ScheduledTaskClientType } from '@/domain/scheduled-task/stub'

type Kind = ScheduledTaskRow['kind']
const KINDS: Kind[] = ['personal', 'team', 'shared']
const PRESETS = { weekdays8: '0 8 * * 1-5', daily8: '0 8 * * *', monday9: '0 9 * * 1', hourly: '0 * * * *' } as const
const CODES = ['not_owner', 'agent_access_denied', 'agent_unavailable', 'limit_exceeded', 'not_allowed'] as const
const button = 'rounded-md border border-ink/20 px-3 py-2 text-sm disabled:opacity-50'
const primary = 'rounded-md bg-ink px-3 py-2 text-sm text-white disabled:opacity-50'
const input = 'w-full rounded-md border border-ink/20 p-2'

export function ScheduledTasksPanel({ tasks, options }: { tasks: ScheduledTaskRow[]; options: ScheduledTaskFormOptions }) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const [showForm, setShowForm] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <section className="space-y-4">
      <details className="max-w-3xl text-sm text-ink-soft">
        <summary className="cursor-pointer font-medium text-ink">? {t('helpLabel')}</summary>
        <p className="mt-2">{t('help')}</p>
      </details>
      {notice ? <p role="status" className="rounded-lg bg-sage/10 p-3 text-sm">{notice}</p> : null}
      {showForm
        ? <CreateForm options={options} onDone={(message) => { setShowForm(false); setNotice(message) }} onCancel={() => setShowForm(false)} />
        : <button type="button" className={primary} onClick={() => { setShowForm(true); setNotice(null) }}>{t('new')}</button>}
      {tasks.length === 0
        ? <p className="text-sm text-ink-soft">{t('empty')}</p>
        : <div className="space-y-4">{tasks.map((task) => <TaskCard key={task.taskId} task={task} options={options} />)}</div>}
    </section>
  )
}

function useErrorText() {
  const t = useTranslations('ControlPlane.scheduledTasks')
  return (code: string) => code === 'conflict' ? t('conflict')
    : (CODES as readonly string[]).includes(code) ? t(`codes.${code as (typeof CODES)[number]}`)
      : code === 'schedule_too_frequent' || code === 'schedule_never_runs' || code === 'invalid_args' ? t(`scheduleErrors.${code}`)
        : t('error')
}

function SchedulePicker({ cron, timezone, onChange }: { cron: string; timezone: string; onChange: (next: { cron?: string; timezone?: string }) => void }) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const [preview, setPreview] = useState<{ description: string; runsPerDay: number | null; error: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await previewScheduleAction({ cron, timezone }).catch(() => null)
      if (!cancelled && result?.success) setPreview(result.data)
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [cron, timezone])
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">{t('when')}</legend>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((key) => (
          <button key={key} type="button" className={PRESETS[key] === cron ? primary : button} onClick={() => onChange({ cron: PRESETS[key] })}>{t(`presets.${key}`)}</button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm text-ink-soft">{t('cron')}<input className={input} value={cron} onChange={(event) => onChange({ cron: event.target.value })} /></label>
        <label className="text-sm text-ink-soft">{t('timezone')}<input className={input} value={timezone} onChange={(event) => onChange({ timezone: event.target.value })} /></label>
      </div>
      {preview ? (
        <p className={preview.error ? 'text-sm text-red-800' : 'text-sm text-ink-soft'}>
          {preview.error ? t(`scheduleErrors.${preview.error as 'invalid_args'}`) : preview.description}
          {!preview.error && preview.runsPerDay ? ` ${t('runsPerDay', { count: preview.runsPerDay })}` : ''}
        </p>
      ) : null}
    </fieldset>
  )
}

function CreateForm({ options, onDone, onCancel }: { options: ScheduledTaskFormOptions; onDone: (message: string) => void; onCancel: () => void }) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const errorText = useErrorText()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('personal')
  const [agentId, setAgentId] = useState(options.agents[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [cron, setCron] = useState<string>(PRESETS.weekdays8)
  const [timezone, setTimezone] = useState('Europe/Budapest')
  const [targets, setTargets] = useState<string[]>(['claude_routine'])
  const [ownerUserId, setOwnerUserId] = useState('')
  const [audience, setAudience] = useState<'selected' | 'agent_operators'>('selected')
  const [memberUserIds, setMemberUserIds] = useState<string[]>([])
  const [ownerSeesResults, setOwnerSeesResults] = useState(false)
  const agent = options.agents.find((row) => row.id === agentId)

  if (options.agents.length === 0) return <p className="text-sm text-ink-soft">{t('noAgents')}</p>

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await createScheduledTaskAction({
        agentId, kind, title, instruction, cron, timezone, targets: targets as ScheduledTaskClientType[],
        ...(kind === 'personal' && ownerUserId ? { ownerUserId } : {}),
        ...(kind !== 'personal' ? { audience, ownerSeesResults, ...(audience === 'selected' ? { memberUserIds } : {}) } : {}),
      }).catch(() => null)
      if (!result?.success) {
        setError(errorText(result?.error ?? 'unavailable'))
        return
      }
      router.refresh()
      onDone(t('created'))
    })
  }

  return (
    <form className="space-y-5 rounded-xl border border-ink/10 bg-white/50 p-5" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <fieldset className="space-y-2">
        <legend className="font-medium">{t('kindQuestion')}</legend>
        <div className="grid gap-3 md:grid-cols-3">
          {KINDS.map((value) => (
            <label key={value} className={`cursor-pointer rounded-lg border p-3 text-sm ${kind === value ? 'border-ink bg-ink/5' : 'border-ink/15'}`}>
              <input type="radio" name="kind" className="sr-only" checked={kind === value} onChange={() => setKind(value)} />
              <span className="block font-medium">{t(`kinds.${value}.name`)}</span>
              <span className="mt-1 block text-ink-soft">{t(`kinds.${value}.body`)}</span>
              <span className="mt-1 block text-ink-faint">{t(`kinds.${value}.example`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">{t('agent')}
        <select className={input} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {options.agents.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </label>
      {kind === 'team' && agent?.userDelegated ? (
        <div role="alert" className="rounded-lg bg-honey/10 p-3 text-sm">
          <p>{t('teamWarning')}</p>
          <button type="button" className={`${button} mt-2`} onClick={() => setKind('shared')}>{t('switchToShared')}</button>
        </div>
      ) : null}
      <label className="block text-sm">{t('taskTitle')}
        <input className={input} maxLength={200} required value={title} placeholder={t('taskTitlePlaceholder')} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="block text-sm">{t('instruction')}
        <textarea className={input} rows={4} maxLength={8000} required value={instruction} placeholder={t('instructionPlaceholder')} onChange={(event) => setInstruction(event.target.value)} />
      </label>
      <SchedulePicker cron={cron} timezone={timezone} onChange={(next) => { if (next.cron !== undefined) setCron(next.cron); if (next.timezone !== undefined) setTimezone(next.timezone) }} />
      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium">{t('where')}</legend>
        {options.clientTypes.map((clientType) => (
          <label key={clientType} className="flex items-center gap-2">
            <input type="checkbox" checked={targets.includes(clientType)} onChange={(event) => setTargets(event.target.checked ? [...targets, clientType] : targets.filter((value) => value !== clientType))} />
            {t(`targets.${clientType as 'other'}`)}
          </label>
        ))}
      </fieldset>
      {kind === 'personal' && options.canCreateForOthers ? (
        <label className="block text-sm">{t('forWhom')}
          <select className={input} value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>
            <option value="">{t('forMe')}</option>
            {options.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
          {ownerUserId ? <span className="mt-1 block text-ink-soft">{t('forOtherNote')}</span> : null}
        </label>
      ) : null}
      {kind !== 'personal' ? (
        <fieldset className="space-y-2 text-sm">
          <legend className="font-medium">{t('audience')}</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={audience === 'selected'} onChange={() => setAudience('selected')} />{t('audienceSelected')}</label>
          {audience === 'selected' ? (
            <div className="ml-6 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
              {options.members.map((member) => (
                <label key={member.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={memberUserIds.includes(member.id)} onChange={(event) => setMemberUserIds(event.target.checked ? [...memberUserIds, member.id] : memberUserIds.filter((id) => id !== member.id))} />
                  {member.name}
                </label>
              ))}
            </div>
          ) : null}
          <label className="flex items-center gap-2"><input type="radio" checked={audience === 'agent_operators'} onChange={() => setAudience('agent_operators')} />{t('audienceOperators', { agent: agent?.name ?? '', count: agent?.operatorCount ?? 0 })}</label>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={ownerSeesResults} onChange={(event) => setOwnerSeesResults(event.target.checked)} />
            <span>{t('ownerSeesResults')}<span className="block text-ink-soft">{t('ownerSeesResultsHint')}</span></span>
          </label>
        </fieldset>
      ) : null}
      {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={pending || !title.trim() || !instruction.trim() || targets.length === 0}>{t('create')}</button>
        <button type="button" className={button} disabled={pending} onClick={onCancel}>{t('closeForm')}</button>
      </div>
    </form>
  )
}

function TaskCard({ task, options }: { task: ScheduledTaskRow; options: ScheduledTaskFormOptions }) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const locale = useLocale()
  const errorText = useErrorText()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: task.title, instruction: task.instruction, cron: task.cron, timezone: task.timezone })
  const [inviting, setInviting] = useState<string[] | null>(null)
  const activeMembers = task.members.filter((row) => row.state === 'active').length

  function run(action: () => Promise<{ success: boolean; error?: string } | null>, after?: () => void) {
    setError(null)
    startTransition(async () => {
      const result = await action().catch(() => null)
      if (!result?.success) {
        setError(errorText(result && 'error' in result && result.error ? result.error : 'unavailable'))
        return
      }
      after?.()
      router.refresh()
    })
  }
  const update = (patch: Partial<{ title: string; instruction: string; cron: string; timezone: string; status: 'active' | 'paused' | 'archived' }>, after?: () => void) =>
    run(() => updateScheduledTaskAction({ taskId: task.taskId, expectedVersion: task.version, ...patch }), after)
  const respond = (response: 'accept' | 'decline') => run(() => respondScheduledTaskAction({ taskId: task.taskId, response, expectedVersion: task.version }))

  return (
    <article className="rounded-xl border border-ink/10 bg-white/50 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-60 max-w-2xl">
          <h2 className="text-base font-medium">{task.title} <Badge tone={task.status === 'active' ? 'success' : 'neutral'}>{t(`statuses.${task.status}`)}</Badge></h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-ink-soft">{task.instruction}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {task.isOwner && task.status !== 'archived' ? (
            <>
              <button type="button" className={button} disabled={pending} onClick={() => setEditing(!editing)}>{t('edit')}</button>
              <button type="button" className={button} disabled={pending} onClick={() => update({ status: task.status === 'active' ? 'paused' : 'active' })}>{task.status === 'active' ? t('pause') : t('resume')}</button>
              <button type="button" className={button} disabled={pending} onClick={() => { if (window.confirm(t('archiveConfirm'))) update({ status: 'archived' }) }}>{t('archive')}</button>
            </>
          ) : null}
          {!task.isOwner && task.myState === 'needs_reconsent' ? <button type="button" className={primary} disabled={pending} onClick={() => respond('accept')}>{t('accept')}</button> : null}
          {task.myState === 'invited' ? <button type="button" className={button} disabled={pending} onClick={() => respond('decline')}>{t('decline')}</button> : null}
          {!task.isOwner && (task.myState === 'active' || task.myState === 'needs_reconsent') ? <button type="button" className={button} disabled={pending} onClick={() => respond('decline')}>{t('leave')}</button> : null}
        </div>
      </div>

      {task.myState === 'invited' ? <p className="mt-3 rounded-lg bg-honey/10 p-3">{t('invitedBanner', { owner: task.ownerName })}</p> : null}
      {!task.isOwner && task.myState === 'needs_reconsent' ? <p className="mt-3 rounded-lg bg-honey/10 p-3">{t('reconsentBanner', { owner: task.ownerName })}</p> : null}

      {task.ownerSeesResults && (task.myState === 'invited' || task.myState === 'needs_reconsent') ? <p className="mt-3 rounded-lg bg-honey/10 p-3">{t('resultsVisibilityWarning', { owner: task.ownerName })}</p> : null}

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-ink-faint">{t('columns.agent')}</dt><dd>{task.agentName}</dd></div>
        <div><dt className="text-ink-faint">{t('columns.who')}</dt><dd>{task.kind === 'personal' ? (task.isOwner ? t('kinds.personal.who') : task.ownerName) : t(`kinds.${task.kind}.who`, { count: activeMembers })}</dd></div>
        <div><dt className="text-ink-faint">{t('columns.when')}</dt><dd>{task.schedule}<span className="block text-xs text-ink-faint">{task.timezone}{task.runsPerDay ? ` · ${t('runsPerDay', { count: task.runsPerDay })}` : ''}</span></dd></div>
        <div>
          <dt className="text-ink-faint">{t('columns.where')}</dt>
          <dd className="space-y-1">
            {task.targetStates.map((target) => (
              <div key={target.clientType}>
                {t(`targetShort.${target.clientType as 'other'}`)}: {target.installed
                  ? <Badge tone="success">{t('installStates.installed')}</Badge>
                  : <><Badge tone="warning">{t('installStates.waiting')}</Badge><span className="block text-xs text-ink-faint">{t('installStates.waitingHint')}</span></>}
              </div>
            ))}
            {task.installations.filter((row) => row.state !== 'installed').map((row, index) => (
              <div key={index} className="text-xs">{t(`targetShort.${row.clientType as 'other'}`)} · {row.userName}: <Badge tone="warning">{t(`installStates.${row.state}`)}</Badge></div>
            ))}
            {task.multipleInstalls ? <div className="text-xs text-ink-soft">{t('installStates.multiple')}</div> : null}
          </dd>
        </div>
      </dl>

      {editing ? (
        <div className="mt-4 space-y-3 border-t border-ink/10 pt-4">
          <label className="block">{t('taskTitle')}<input className={input} maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="block">{t('instruction')}<textarea className={input} rows={4} maxLength={8000} value={draft.instruction} onChange={(event) => setDraft({ ...draft, instruction: event.target.value })} /></label>
          {task.kind !== 'personal' ? <p className="text-ink-soft">{t('editReconsentNote')}</p> : null}
          <SchedulePicker cron={draft.cron} timezone={draft.timezone} onChange={(next) => setDraft({ ...draft, ...next })} />
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={pending} onClick={() => update({
              ...(draft.title !== task.title ? { title: draft.title } : {}),
              ...(draft.instruction !== task.instruction ? { instruction: draft.instruction } : {}),
              ...(draft.cron !== task.cron ? { cron: draft.cron } : {}),
              ...(draft.timezone !== task.timezone ? { timezone: draft.timezone } : {}),
            }, () => setEditing(false))}>{t('save')}</button>
            <button type="button" className={button} disabled={pending} onClick={() => setEditing(false)}>{t('cancel')}</button>
          </div>
        </div>
      ) : null}

      {task.kind !== 'personal' && task.members.length ? (
        <div className="mt-4 border-t border-ink/10 pt-3">
          <h3 className="font-medium">{t('members')}</h3>
          <ul className="mt-1 flex flex-wrap gap-2">
            {task.members.map((member) => (
              <li key={member.userId}>{member.name}: <Badge tone={member.state === 'active' && member.installed ? 'success' : member.state === 'declined' || member.state === 'left' ? 'neutral' : 'warning'}>
                {member.state === 'active' && !member.installed ? t('memberStates.activeNotInstalled') : t(`memberStates.${member.state}`)}
              </Badge></li>
            ))}
          </ul>
          {task.isOwner && task.audience === 'selected' && task.status !== 'archived' ? (
            inviting === null
              ? <button type="button" className={`${button} mt-2`} onClick={() => setInviting([])}>{t('invite')}</button>
              : (
                <div className="mt-2 space-y-2">
                  <p>{t('invitePick')}</p>
                  <div className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
                    {options.members.filter((member) => !task.members.some((row) => row.userId === member.id && row.state !== 'declined' && row.state !== 'left')).map((member) => (
                      <label key={member.id} className="flex items-center gap-2">
                        <input type="checkbox" checked={inviting.includes(member.id)} onChange={(event) => setInviting(event.target.checked ? [...inviting, member.id] : inviting.filter((id) => id !== member.id))} />
                        {member.name}
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className={primary} disabled={pending || inviting.length === 0} onClick={() => run(() => inviteScheduledTaskMembersAction({ taskId: task.taskId, userIds: inviting }), () => setInviting(null))}>{t('invite')}</button>
                    <button type="button" className={button} onClick={() => setInviting(null)}>{t('cancel')}</button>
                  </div>
                </div>
              )
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 border-t border-ink/10 pt-3">
        <h3 className="font-medium">{t('columns.lastRun')}</h3>
        {task.runs.length === 0 ? <p className="text-ink-soft">{t('noRuns')}</p> : (
          <ul className="mt-1 space-y-1">
            {task.runs.map((runRow) => (
              <li key={runRow.runId}>
                <time dateTime={runRow.slot}>{formatDateTime(runRow.slot, locale, task.timezone)}</time>{' '}
                <Badge tone={runRow.status === 'succeeded' ? 'success' : runRow.status === 'running' ? 'neutral' : 'warning'}>{t(`runStatuses.${runRow.status as 'running'}`)}</Badge>
                {runRow.catchUp ? <span className="ml-1 text-xs text-ink-faint">({t('catchUp')})</span> : null}
                {task.kind === 'team' ? <span className="ml-1 text-ink-soft">— {t('ranBy', { name: runRow.runnerName })}</span> : null}
                {runRow.status === 'missed' ? <span className="ml-1 text-xs text-ink-faint">{t('missedHint')}</span> : null}
                {runRow.summary ? <p className="whitespace-pre-wrap text-ink-soft">{runRow.summary}</p> : null}
                {runRow.mine ? <RunTimeline runId={runRow.runId} timezone={task.timezone} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error ? <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-red-800">{error}</p> : null}
    </article>
  )
}

function RunTimeline({ runId, timezone }: { runId: string; timezone: string }) {
  const t = useTranslations('ControlPlane.scheduledTasks')
  const locale = useLocale()
  const [calls, setCalls] = useState<Array<{ toolName: string; at: string }> | null>(null)
  const [pending, startTransition] = useTransition()
  if (calls === null) {
    return (
      <button type="button" className="text-xs underline" disabled={pending} onClick={() => startTransition(async () => {
        const result = await listRunToolCallsAction(runId).catch(() => null)
        setCalls(result?.success ? result.data.calls : [])
      })}>{t('timeline')}</button>
    )
  }
  if (calls.length === 0) return <p className="text-xs text-ink-faint">{t('timelineEmpty')}</p>
  return (
    <ol className="ml-4 list-decimal text-xs text-ink-soft">
      {calls.map((call, index) => <li key={index}><time dateTime={call.at}>{formatDateTime(call.at, locale, timezone)}</time> — {call.toolName}</li>)}
    </ol>
  )
}
