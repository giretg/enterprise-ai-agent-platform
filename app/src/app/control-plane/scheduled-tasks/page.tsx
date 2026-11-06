import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { listScheduledTasksAction, scheduledTaskFormOptionsAction } from '@/app/actions/scheduled-task'
import { parsePlatformChatAgentParam } from '@/lib/platform-chat-href'
import { ScheduledTasksPanel } from './scheduled-tasks-panel'

export default async function ScheduledTasksPage({ searchParams }: { searchParams: Promise<{ archived?: string; agent?: string }> }) {
  const query = await searchParams
  const archived = query.archived === '1'
  // A munkatárs-doboz gombjától jön: csak az ő feladatait mutatja.
  const agentFilter = parsePlatformChatAgentParam(query.agent)
  const pageHref = (params: { archived?: boolean; agent?: string | null }) => {
    const search = new URLSearchParams()
    if (params.archived) search.set('archived', '1')
    if (params.agent) search.set('agent', params.agent)
    const qs = search.toString()
    return `/control-plane/scheduled-tasks${qs ? `?${qs}` : ''}`
  }
  await requireTenantRole('viewer')
  const [result, options, t] = await Promise.all([
    listScheduledTasksAction(archived, agentFilter ?? undefined),
    scheduledTaskFormOptionsAction(),
    getTranslations('ControlPlane.scheduledTasks'),
  ])
  const tasks = result.success ? result.data.tasks : []
  // Az űrlap csak a működtethető munkatársakat ismeri, a megfigyelőnek a feladat sorából jön a név.
  const filteredAgentName = agentFilter
    ? (tasks[0]?.agentName ?? (options.success ? options.data.agents.find((agent) => agent.id === agentFilter)?.name : null) ?? null)
    : null
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <nav className="flex flex-wrap items-baseline gap-4 text-sm">
        <Link href={pageHref({ archived: !archived, agent: agentFilter })} className="text-ink-soft underline">
          {archived ? t('hideArchived') : t('showArchived')}
        </Link>
        {agentFilter ? (
          <span className="text-ink-soft">
            {filteredAgentName ? t('filteredBy', { agent: filteredAgentName }) : null}{' '}
            <Link href={pageHref({ archived })} className="text-coral-deep underline">{t('clearFilter')}</Link>
          </span>
        ) : null}
      </nav>
      {result.success && options.success
        ? <ScheduledTasksPanel tasks={tasks} options={options.data} />
        : <p role="alert" className="text-red-800">{t('error')}</p>}
    </div>
  )
}
