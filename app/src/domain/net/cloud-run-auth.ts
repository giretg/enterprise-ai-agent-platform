type MetadataTokenResponse = {
  access_token?: string
}

export async function getCloudRunAccessToken(explicitToken?: string): Promise<string> {
  if (explicitToken?.trim()) return explicitToken.trim()

  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!response.ok) {
    throw new Error(`Metadata server token request failed: ${response.status}`)
  }

  const data = (await response.json()) as MetadataTokenResponse
  if (!data.access_token) throw new Error('Metadata server token response is missing access_token')
  return data.access_token
}

export function cloudRunJobRunEndpoint(projectId: string, location: string, jobName: string): string {
  return [
    'https://run.googleapis.com/v2/projects',
    encodeURIComponent(projectId),
    'locations',
    encodeURIComponent(location),
    'jobs',
    encodeURIComponent(jobName),
  ].join('/')
}

export type CloudRunExecutionStatus = 'running' | 'succeeded' | 'failed' | 'unknown'

export async function fetchCloudRunExecutionStatus(
  executionName: string,
  token: string,
): Promise<{ status: CloudRunExecutionStatus; detail?: string }> {
  const response = await fetch(`https://run.googleapis.com/v2/${executionName}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloud Run execution fetch failed: ${response.status} ${body.slice(0, 300)}`)
  }

  // A jobs:run egy long-running Operationt ad vissza (projects/…/operations/…),
  // ami a job futás befejezésekor lesz done. Ilyenkor az operation állapotát
  // értelmezzük, nem az Execution conditions-t.
  if (executionName.includes('/operations/')) {
    const op = (await response.json()) as {
      done?: boolean
      error?: { message?: string }
      response?: { name?: string }
    }
    if (op.error) return { status: 'failed', detail: op.error.message }
    if (op.done) return { status: 'succeeded' }
    return { status: 'running' }
  }

  const data = (await response.json()) as {
    conditions?: Array<{ type?: string; state?: string; message?: string }>
    completionStatus?: string
  }

  const completed = data.conditions?.find((condition) => condition.type === 'Completed')
  if (completed?.state === 'CONDITION_SUCCEEDED') return { status: 'succeeded' }
  if (completed?.state === 'CONDITION_FAILED') {
    return { status: 'failed', detail: completed.message ?? data.completionStatus }
  }

  const started = data.conditions?.find((condition) => condition.type === 'Started')
  if (started?.state === 'CONDITION_SUCCEEDED' || started?.state === 'CONDITION_PENDING') {
    return { status: 'running' }
  }

  return { status: 'unknown', detail: completed?.message }
}

export async function waitForCloudRunExecution(
  executionName: string,
  token: string,
  timeoutMs: number,
  pollIntervalMs = 3000,
): Promise<{ status: CloudRunExecutionStatus; detail?: string }> {
  const deadline = Date.now() + timeoutMs
  let last: { status: CloudRunExecutionStatus; detail?: string } = { status: 'unknown' }

  while (Date.now() < deadline) {
    last = await fetchCloudRunExecutionStatus(executionName, token)
    if (last.status === 'succeeded' || last.status === 'failed') return last
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  return { ...last, detail: last.detail ?? `timeout after ${timeoutMs}ms` }
}
