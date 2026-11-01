import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { listScheduledTasksAction, scheduledTaskFormOptionsAction } from '@/app/actions/scheduled-task'
import { ScheduledTasksPanel } from './scheduled-tasks-panel'

export default async function ScheduledTasksPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const query = await searchParams
  const archived = query.archived === '1'
  await requireTenantRole('viewer')
  const [result, options, t] = await Promise.all([
    listScheduledTasksAction(archived),
    scheduledTaskFormOptionsAction(),
    getTranslations('ControlPlane.scheduledTasks'),
  ])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <nav className="flex gap-4 text-sm">
        <Link href={archived ? '/control-plane/scheduled-tasks' : '/control-plane/scheduled-tasks?archived=1'} className="text-ink-soft underline">
          {archived ? t('hideArchived') : t('showArchived')}
        </Link>
      </nav>
      {result.success && options.success
        ? <ScheduledTasksPanel tasks={result.data.tasks} options={options.data} />
        : <p role="alert" className="text-red-800">{t('error')}</p>}
    </div>
  )
}
