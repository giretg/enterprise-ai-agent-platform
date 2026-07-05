import { getCloudRunAccessToken } from './cloud-run-auth'

const MIN_SCALE_ANNOTATION = 'autoscaling.knative.dev/minScale'

export type DispatcherServiceStatus = {
  minScale: number | null
  ready: boolean
  latestReadyRevisionName: string | null
  url: string | null
}

type KnativeService = {
  metadata?: { resourceVersion?: string }
  spec?: { template?: { metadata?: { annotations?: Record<string, string> } } }
  status?: {
    url?: string
    latestReadyRevisionName?: string
    conditions?: Array<{ type?: string; status?: string }>
  }
}

function serviceEndpoint(): string {
  const projectId = requireConfig('DISPATCHER_ADMIN_PROJECT_ID', process.env.DISPATCHER_ADMIN_PROJECT_ID)
  const region = requireConfig('DISPATCHER_ADMIN_REGION', process.env.DISPATCHER_ADMIN_REGION)
  const serviceName = requireConfig(
    'DISPATCHER_ADMIN_SERVICE_NAME',
    process.env.DISPATCHER_ADMIN_SERVICE_NAME,
  )
  return [
    'https://run.googleapis.com/v1/projects',
    encodeURIComponent(projectId),
    'locations',
    encodeURIComponent(region),
    'services',
    encodeURIComponent(serviceName),
  ].join('/')
}

function requireConfig(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`Missing ${name} for Cloud Run dispatcher admin`)
  return trimmed
}

async function fetchService(token: string): Promise<KnativeService> {
  const response = await fetch(serviceEndpoint(), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloud Run service fetch failed: ${response.status} ${body.slice(0, 300)}`)
  }
  return (await response.json()) as KnativeService
}

function toStatus(service: KnativeService): DispatcherServiceStatus {
  const minScaleRaw = service.spec?.template?.metadata?.annotations?.[MIN_SCALE_ANNOTATION]
  const ready = service.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  )
  return {
    minScale: minScaleRaw !== undefined ? Number(minScaleRaw) : null,
    ready: ready ?? false,
    latestReadyRevisionName: service.status?.latestReadyRevisionName ?? null,
    url: service.status?.url ?? null,
  }
}

export async function getDispatcherServiceStatus(): Promise<DispatcherServiceStatus> {
  const token = await getCloudRunAccessToken(process.env.CLOUD_RUN_ADMIN_BEARER_TOKEN)
  const service = await fetchService(token)
  return toStatus(service)
}

/**
 * A Cloud Run (Knative-stílusú) Admin API a minScale annotáció módosítását csak
 * get→módosítás→replace (PUT) mintával támogatja megbízhatóan — ugyanezt teszi a
 * `gcloud run services update --min-instances` is a háttérben.
 */
export async function setDispatcherServiceMinScale(minScale: 0 | 1): Promise<DispatcherServiceStatus> {
  const token = await getCloudRunAccessToken(process.env.CLOUD_RUN_ADMIN_BEARER_TOKEN)
  const service = await fetchService(token)

  if (!service.spec?.template?.metadata) {
    throw new Error('Unexpected Cloud Run service shape: missing spec.template.metadata')
  }
  service.spec.template.metadata.annotations = {
    ...service.spec.template.metadata.annotations,
    [MIN_SCALE_ANNOTATION]: String(minScale),
  }

  const response = await fetch(serviceEndpoint(), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(service),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloud Run service update failed: ${response.status} ${body.slice(0, 300)}`)
  }

  return toStatus((await response.json()) as KnativeService)
}
