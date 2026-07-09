import { getCloudRunAccessToken } from './cloud-run-auth'

/**
 * Cloud Scheduler admin wrapper a `dispatch-cycle-sweep` job be/ki kapcsolásához és
 * intervallum-állításához az admin UI-ból (§5.7 kiegészítés — analóg a Cloud Run
 * `cloud-run-service-admin.ts`-szel). A `getCloudRunAccessToken` név történelmi — ez egy
 * generikus GCP access token lekérő (metadata-szerver vagy explicit bearer), bármely
 * Google API híváshoz újrahasználható, nem csak Cloud Runhoz.
 */

export type SchedulerJobState = 'ENABLED' | 'PAUSED' | 'UNKNOWN'

export type SchedulerJobStatus = {
  state: SchedulerJobState
  schedule: string | null
  timeZone: string | null
  lastAttemptStatus: string | null
}

type SchedulerJobResource = {
  state?: string
  schedule?: string
  timeZone?: string
  status?: { code?: number; message?: string }
  lastAttemptTime?: string
}

function requireConfig(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`Missing ${name} for Cloud Scheduler admin`)
  return trimmed
}

function jobEndpoint(): string {
  const projectId = requireConfig('DISPATCHER_ADMIN_PROJECT_ID', process.env.DISPATCHER_ADMIN_PROJECT_ID)
  const location = requireConfig('DISPATCHER_ADMIN_REGION', process.env.DISPATCHER_ADMIN_REGION)
  const jobName = requireConfig(
    'DISPATCHER_SCHEDULER_JOB_NAME',
    process.env.DISPATCHER_SCHEDULER_JOB_NAME ?? 'dispatch-cycle-sweep',
  )
  return [
    'https://cloudscheduler.googleapis.com/v1/projects',
    encodeURIComponent(projectId),
    'locations',
    encodeURIComponent(location),
    'jobs',
    encodeURIComponent(jobName),
  ].join('/')
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getCloudRunAccessToken(process.env.CLOUD_RUN_ADMIN_BEARER_TOKEN)
  return { authorization: `Bearer ${token}` }
}

function toStatus(job: SchedulerJobResource): SchedulerJobStatus {
  const state: SchedulerJobState =
    job.state === 'ENABLED' || job.state === 'PAUSED' ? job.state : 'UNKNOWN'
  return {
    state,
    schedule: job.schedule ?? null,
    timeZone: job.timeZone ?? null,
    lastAttemptStatus: job.status
      ? `${job.status.code ?? 0}${job.status.message ? `: ${job.status.message}` : ''}`
      : null,
  }
}

async function readJson(response: Response, action: string): Promise<SchedulerJobResource> {
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloud Scheduler ${action} failed: ${response.status} ${body.slice(0, 300)}`)
  }
  return (await response.json()) as SchedulerJobResource
}

export async function getSchedulerJobStatus(): Promise<SchedulerJobStatus> {
  const response = await fetch(jobEndpoint(), { headers: await authHeader() })
  return toStatus(await readJson(response, 'job fetch'))
}

export async function setSchedulerJobPaused(paused: boolean): Promise<SchedulerJobStatus> {
  const action = paused ? 'pause' : 'resume'
  const response = await fetch(`${jobEndpoint()}:${action}`, {
    method: 'POST',
    headers: await authHeader(),
  })
  return toStatus(await readJson(response, `job ${action}`))
}

/** `intervalMinutes` 2 és 59 között — a job onnantól N percenként (cron: star-slash-N óra-perc mintával) fut. */
export async function setSchedulerJobIntervalMinutes(intervalMinutes: number): Promise<SchedulerJobStatus> {
  const clamped = Math.max(2, Math.min(59, Math.round(intervalMinutes)))
  const response = await fetch(`${jobEndpoint()}?updateMask=schedule`, {
    method: 'PATCH',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    body: JSON.stringify({ schedule: `*/${clamped} * * * *` }),
  })
  return toStatus(await readJson(response, 'schedule update'))
}
