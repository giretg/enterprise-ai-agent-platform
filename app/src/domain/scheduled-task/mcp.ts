import { z } from 'zod'
import type { EnterpriseToolMcpResult } from '@/domain/enterprise-tools'
import type { AuditSink } from '@/lib/audit/types'
import { parseClient, type ScheduledTaskPrincipal, type ScheduledTaskService } from './scheduled-task-service'
import { SCHEDULED_TASK_CLIENT_TYPES } from './stub'

/** #640 §4: `platform.scheduled_task.*`. A userId/tenantId mindig a principal-ból jön. */
export const SCHEDULED_TASK_TOOLS = [
  'platform.scheduled_task.list',
  'platform.scheduled_task.get',
  'platform.scheduled_task.create',
  'platform.scheduled_task.update',
  'platform.scheduled_task.sync',
  'platform.scheduled_task.install_report',
  'platform.scheduled_task.run_start',
  'platform.scheduled_task.run_finish',
] as const
export type ScheduledTaskToolName = (typeof SCHEDULED_TASK_TOOLS)[number]

export function isScheduledTaskTool(name: string): name is ScheduledTaskToolName {
  return (SCHEDULED_TASK_TOOLS as readonly string[]).includes(name)
}

const clientType = z.enum(SCHEDULED_TASK_CLIENT_TYPES)
const client = z.object({
  clientType,
  clientInstanceId: z.string().min(1).max(200).describe('Stable id of this machine/account: checkout manifest UUID; claude_routine: "<userId>:routine"; Hermes: profile id.'),
}).passthrough()
const uuid = z.string().uuid()

export const scheduledTaskSchemas: Record<ScheduledTaskToolName, z.ZodTypeAny> = {
  'platform.scheduled_task.list': z.object({ agentId: uuid.optional(), scope: z.enum(['mine', 'tenant']).optional() }).passthrough(),
  'platform.scheduled_task.get': z.object({ taskId: uuid, client: client.optional() }).passthrough(),
  'platform.scheduled_task.create': z.object({
    agentId: uuid,
    title: z.string().min(1).max(200),
    instruction: z.string().min(1).max(8000).describe('What the agent should do on every run.'),
    cron: z.string().max(200).describe('5-field cron in timezone, at most every 15 minutes, e.g. "0 8 * * 1-5".'),
    timezone: z.string().max(100).optional().describe('IANA, default Europe/Budapest.'),
    targets: z.array(clientType).max(6).optional().describe('Client types to install on; default: this client.'),
    client: client.optional(),
  }).passthrough(),
  'platform.scheduled_task.update': z.object({
    taskId: uuid,
    expectedVersion: z.number().int(),
    title: z.string().max(200).optional(),
    instruction: z.string().max(8000).optional(),
    cron: z.string().max(200).optional(),
    timezone: z.string().max(100).optional(),
    status: z.enum(['active', 'paused']).optional(),
    targets: z.array(clientType).max(6).optional(),
  }).passthrough(),
  'platform.scheduled_task.sync': z.object({
    client,
    agentId: uuid.optional(),
    unattended: z.boolean().optional().describe('true from the daily sync stub: questions are deferred.'),
    inventory: z.array(z.object({
      externalId: z.string().max(200),
      taskId: z.string().max(64),
      cron: z.string().max(200),
      timezone: z.string().max(100),
      enabled: z.boolean(),
      stubText: z.string().max(2000).optional().describe('The scheduled prompt as it is on this client.'),
    }).passthrough()).max(200).describe('Only platform stubs (prompt contains a taskId). Never list other scheduled tasks.'),
  }).passthrough(),
  'platform.scheduled_task.install_report': z.object({
    client,
    reports: z.array(z.object({
      taskId: uuid,
      externalId: z.string().max(200).optional(),
      action: z.enum(['installed', 'updated', 'removed', 'disabled', 'accepted', 'declined']),
      scheduleHash: z.string().max(64).optional(),
      stubHash: z.string().max(64).optional(),
      locallyDisabled: z.boolean().optional(),
    }).passthrough()).min(1).max(100),
  }).passthrough(),
  'platform.scheduled_task.run_start': z.object({
    taskId: uuid,
    installation: client.extend({ externalId: z.string().max(200).optional() }).optional(),
    catchUp: z.boolean().optional().describe('Only when the user explicitly asks to catch up the latest missed run.'),
  }).passthrough(),
  'platform.scheduled_task.run_finish': z.object({
    runId: uuid,
    status: z.enum(['succeeded', 'failed']),
    summary: z.string().max(2000).optional(),
  }).passthrough(),
}

/**
 * A hirdetett séma felső szintjén nincs tömb (egyes MCP-kliensek elrontják): a `targets`
 * vesszővel elválasztott szöveg, az `inventory`/`reports` JSON-szöveg. Belül tömbként validálunk.
 */
const LIST_FIELDS: Record<string, 'csv' | 'json'> = { targets: 'csv', inventory: 'json', reports: 'json' }
const LIST_HINTS: Record<string, string> = {
  targets: 'Comma-separated client types to install on (claude_routine, claude_desktop, codex, goose, hermes, other); default: this client.',
  inventory: 'JSON array of the platform stubs on this client: [{"externalId","taskId","cron","timezone","enabled","stubText"}]. Only platform stubs (prompt contains a taskId); never list other scheduled tasks.',
  reports: 'JSON array: [{"taskId","externalId","action":"installed|updated|removed|disabled|accepted|declined","scheduleHash","stubHash","locallyDisabled"}] — copy the report steps of the sync plan.',
}

function advertised(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    shape[key] = LIST_FIELDS[key] ? (field.isOptional() ? z.string().optional() : z.string()).describe(LIST_HINTS[key]) : field
  }
  return z.object(shape).passthrough()
}

export const scheduledTaskInputSchemas = Object.fromEntries(
  Object.entries(scheduledTaskSchemas).map(([name, schema]) => [name, advertised(schema)]),
) as Record<ScheduledTaskToolName, z.ZodTypeAny>

function normalizeLists(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args }
  for (const [key, mode] of Object.entries(LIST_FIELDS)) {
    const value = out[key]
    if (typeof value !== 'string') continue
    if (mode === 'csv') out[key] = value.split(',').map((part) => part.trim()).filter(Boolean)
    else {
      try {
        out[key] = JSON.parse(value)
      } catch {
        // marad szöveg → a séma invalid_args-ot ad
      }
    }
  }
  return out
}

export const SCHEDULED_TASK_DESCRIPTIONS: Record<ScheduledTaskToolName, string> = {
  'platform.scheduled_task.list': 'List your scheduled tasks (recurring agent work that your own client schedules and runs).',
  'platform.scheduled_task.get': 'Read one scheduled task. Pass client to get its install recipe for this client.',
  'platform.scheduled_task.create': 'Register recurring work on the platform first, then install the returned recipe in this client\'s own scheduler and call install_report. Runs in your name.',
  'platform.scheduled_task.update': 'Change your scheduled task (owner only). Pass expectedVersion; a conflict returns the fresh task.',
  'platform.scheduled_task.sync': 'Compare the platform stubs installed on this client with the platform. Returns a plan: carry out its actions, ask the user its questions, then install_report.',
  'platform.scheduled_task.install_report': 'Report what you installed, updated, removed or disabled on this client (batch).',
  'platform.scheduled_task.run_start': 'First call of a scheduled stub: claims this scheduled time and returns the instruction to follow, or skip/deny (then stop).',
  'platform.scheduled_task.run_finish': 'Close a scheduled run with succeeded|failed and a short summary.',
}

export type ScheduledTaskMcpDeps = {
  scheduledTasks: ScheduledTaskService
  audit?: AuditSink
  resolveLanguage?: (tenantId: string) => Promise<'hu' | 'en'>
}

function result(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export async function invokeScheduledTask(deps: ScheduledTaskMcpDeps, input: {
  principal: ScheduledTaskPrincipal; toolName: string; args: Record<string, unknown>
}): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args } = input
  if (!isScheduledTaskTool(toolName)) return result({ code: 'not_found' }, true)
  const parsed = scheduledTaskSchemas[toolName].safeParse(normalizeLists(args))
  if (!parsed.success) {
    return result({ code: 'invalid_args', issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, true)
  }
  const a = parsed.data as Record<string, unknown>
  const svc = deps.scheduledTasks
  const language = await deps.resolveLanguage?.(principal.tenantId).catch(() => 'en' as const) ?? 'en'
  const reply = (payload: { ok: boolean } & Record<string, unknown>) => result(payload, !payload.ok && payload.outcome === undefined)

  switch (toolName) {
    case 'platform.scheduled_task.list': {
      const found = await svc.list(principal, { agentId: a.agentId as string | undefined, scope: a.scope as 'mine' | 'tenant' | undefined })
      return reply({ ok: true, tasks: found.tasks.map((task) => svc.view(task, { ...found, viewerUserId: principal.userId, language })) })
    }
    case 'platform.scheduled_task.get': {
      const found = await svc.get(principal, a.taskId as string)
      if (!found.ok) return reply(found)
      const c = parseClient(a.client)
      return reply({
        ok: true,
        task: svc.view(found.task, { ...found, viewerUserId: principal.userId, client: c, language }),
        ...(c ? { recipe: svc.recipe(found.task, c) } : {}),
      })
    }
    case 'platform.scheduled_task.create': {
      const c = parseClient(a.client)
      const created = await svc.create(principal, { ...a, kind: 'personal', clientType: c?.clientType ?? undefined, memberUserIds: undefined, ownerUserId: undefined, audience: undefined })
      if (!created.ok) return reply(created)
      return reply({
        ok: true,
        task: svc.view(created.task, { viewerUserId: principal.userId, client: c, language }),
        ...(c ? { recipe: svc.recipe(created.task, c), next: 'Install the recipe in this client\'s scheduler, then call platform.scheduled_task.install_report with action "installed".' } : { next: 'Call platform.scheduled_task.get with client to get the install recipe.' }),
      })
    }
    case 'platform.scheduled_task.update': {
      const updated = await svc.update(principal, a)
      return updated.ok ? reply({ ok: true, task: svc.view(updated.task, { viewerUserId: principal.userId, language }), next: 'Other installations update at their next sync or run.' }) : reply(updated)
    }
    case 'platform.scheduled_task.sync':
      return reply(await svc.sync(principal, a))
    case 'platform.scheduled_task.install_report':
      return reply(await svc.installReport(principal, { client: a.client, reports: a.reports }))
    case 'platform.scheduled_task.run_start':
      return reply(await svc.runStart(principal, a))
    case 'platform.scheduled_task.run_finish':
      return reply(await svc.runFinish(principal, a))
  }
}
