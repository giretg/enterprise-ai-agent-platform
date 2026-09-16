import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  executeCloudRunSandbox,
  authorizeSandboxRequest,
} from '@/domain/code-sandbox/cloud-run-runner'
import { smokeSandboxRequest } from '@/domain/code-sandbox/code-sandbox-types'

const maxRequestBytes = Number(
  process.env.CODE_SANDBOX_MAX_REQUEST_BYTES ?? 30 * 1024 * 1024,
)

createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json')
  if (
    request.method !== 'POST' ||
    !['/v1/execute', '/v1/smoke'].includes(request.url ?? '')
  ) {
    response.writeHead(404).end(JSON.stringify({ error: 'not_found' }))
    return
  }
  if (!authorizeSandboxRequest(request.headers.authorization)) {
    response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maxRequestBytes) throw new Error('request_too_large')
      chunks.push(bytes)
    }
    const body =
      request.url === '/v1/smoke'
        ? { id: randomUUID(), ...smokeSandboxRequest() }
        : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const result = await executeCloudRunSandbox(body)
    response.writeHead(200).end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(400).end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'sandbox_failed',
      }),
    )
  }
}).listen(Number(process.env.PORT ?? 8080))
