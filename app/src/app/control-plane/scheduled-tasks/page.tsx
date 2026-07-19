import { listAgents, listScheduledTasks } from '@/app/actions/platform'
import {
  ScheduledTaskList,
  type ScheduledTaskAgentView,
  type ScheduledTaskView,
} from '@/components/scheduled-tasks/scheduled-task-list'

export default async function ScheduledTasksPage() {
  const [tasksRes, agentsRes] = await Promise.all([listScheduledTasks(), listAgents()])
  const tasks: ScheduledTaskView[] = tasksRes.success
    ? tasksRes.data.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        agentId: task.agentId,
        nextRunAt: task.nextRunAt.toISOString(),
        recurrence: task.recurrence,
        runCount: task.runCount,
        maxRuns: task.maxRuns,
        runAsUserId: task.runAsUserId,
        materializedTicketId: task.materializedTicketId,
        payload: task.payload,
      }))
    : []
  const agents: ScheduledTaskAgentView[] = agentsRes.success
    ? agentsRes.data.map((agent) => ({
        id: agent.id,
        name: agent.name,
        personaNickname: agent.personaNickname,
      }))
    : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Ütemezett taskok</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            One-shot és ismétlődő agent feladatok explicit run-as felhatalmazással. A dispatcher
            worker a futási időpontban ticketet materializál belőlük.
          </p>
        </div>
      </div>

      {!tasksRes.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni az ütemezett taskokat: {tasksRes.error}
        </p>
      )}

      <ScheduledTaskList tasks={tasks} agents={agents} />
    </div>
  )
}
