/**
 * GCP Cloud Run Job harness smoke — Epik 5 proof.
 *
 * Előfeltétel:
 *   npm run harness:cloud-run-deploy   (vagy meglévő job)
 *   Platform elérhető PLATFORM_API_URL-ről (callback + gateway)
 *   HARNESS_CLOUD_RUN_* + HARNESS_CALLBACK_TOKEN + PLATFORM_API_URL env
 *
 * Futtatás: npm run harness:cloud-run-smoke
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'
import { CloudRunJobHarnessLauncher, cloudRunConfigFromEnv } from '../src/domain/dispatcher/cloud-run-job-launcher'
import { getCloudRunAccessToken, waitForCloudRunExecution } from '../src/domain/dispatcher/cloud-run-auth'
import { readSeedApiKey, isPlatformReachable, platformBaseUrl } from './harness-docker-shared'

const SAMPLE_QUESTION =
  'Mi az MVP célja, és milyen átjárókon kell átmennie az agent műveleteinek?'
const EXECUTION_TIMEOUT_MS = Number(process.env.HARNESS_CLOUD_RUN_SMOKE_TIMEOUT_MS ?? '300000')

async function main() {
  const platformUrl = process.env.PLATFORM_API_URL?.trim() ?? platformBaseUrl('127.0.0.1', '3000')

  for (const key of [
    'HARNESS_CLOUD_RUN_PROJECT_ID',
    'HARNESS_CLOUD_RUN_LOCATION',
    'HARNESS_CLOUD_RUN_JOB_NAME',
    'HARNESS_CALLBACK_TOKEN',
  ]) {
    if (!process.env[key]?.trim()) {
      console.error(`[cloud-run-smoke] FAIL: missing ${key}`)
      process.exit(1)
    }
  }

  if (!(await isPlatformReachable(platformUrl))) {
    console.error(`[cloud-run-smoke] FAIL: platform not reachable at ${platformUrl}`)
    process.exit(1)
  }

  process.env.PLATFORM_API_URL = platformUrl
  if (!process.env.MODEL_GATEWAY_URL?.trim()) {
    process.env.MODEL_GATEWAY_URL = `${platformUrl.replace(/\/$/, '')}/api/v1/gateway/v1`
  }
  if (!process.env.HARNESS_CALLBACK_URL?.trim()) {
    process.env.HARNESS_CALLBACK_URL = platformUrl
  }

  const agent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
  const operator = await prisma.user.findUnique({ where: { externalAuthId: 'seed-operator' } })
  if (!agent || !operator) throw new Error('Seed hiányzik — npm run db:seed')

  const ticketId = randomUUID()
  const lockToken = randomUUID()
  const agentApiKey = await readSeedApiKey()

  await prisma.ticket.create({
    data: {
      id: ticketId,
      type: 'interaction',
      title: 'Cloud Run harness smoke',
      state: 'in_progress',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: {
        question: SAMPLE_QUESTION,
        agentVersion: agent.currentVersion,
      },
      lockToken,
      lockedAt: new Date(),
      createdById: operator.id,
    },
  })

  console.log(`[cloud-run-smoke] ticket=${ticketId}`)
  console.log(`[cloud-run-smoke] platform=${platformUrl}`)
  console.log(
    `[cloud-run-smoke] job=${process.env.HARNESS_CLOUD_RUN_PROJECT_ID}/${process.env.HARNESS_CLOUD_RUN_LOCATION}/${process.env.HARNESS_CLOUD_RUN_JOB_NAME}`,
  )

  const launcher = new CloudRunJobHarnessLauncher({
    ...cloudRunConfigFromEnv(),
    platformApiUrl: platformUrl,
    harnessAgentApiKey: agentApiKey,
    stubBrokerFallback: true,
  })

  let executionName: string | undefined
  try {
    const launched = await launcher.launch({
      ticketId,
      agentId: agent.id,
      lockToken,
      agentVersion: agent.currentVersion,
      question: SAMPLE_QUESTION,
    })
    executionName = launched.executionName
    console.log(`[cloud-run-smoke] execution=${executionName ?? launched.jobId}`)

    if (executionName) {
      const token = await getCloudRunAccessToken(process.env.HARNESS_CLOUD_RUN_BEARER_TOKEN)
      const exec = await waitForCloudRunExecution(
        executionName,
        token,
        EXECUTION_TIMEOUT_MS,
      )
      console.log(`[cloud-run-smoke] execution status=${exec.status} detail=${exec.detail ?? 'n/a'}`)
      if (exec.status === 'failed') {
        console.error('[cloud-run-smoke] FAIL: Cloud Run execution failed')
        process.exit(1)
      }
    }

    const deadline = Date.now() + 30_000
    let ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    while (Date.now() < deadline && ticket?.lockToken) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    }

    const payload = ticket?.payload as { answer?: string } | null
    const modelCalls = await prisma.modelCall.count({ where: { ticketId } })
    const toolCalls = await prisma.toolCall.count({ where: { ticketId } })

    console.log(
      `[cloud-run-smoke] state=${ticket?.state} lock=${ticket?.lockToken ?? 'null'} modelCalls=${modelCalls} toolCalls=${toolCalls}`,
    )

    if (ticket?.lockToken) {
      console.error('[cloud-run-smoke] FAIL: lock not released after completion callback')
      process.exit(1)
    }

    if (modelCalls === 0) {
      console.error('[cloud-run-smoke] FAIL: no model_calls — Gateway átjáró nem futott')
      process.exit(1)
    }

    if (toolCalls === 0) {
      console.error('[cloud-run-smoke] FAIL: no tool_calls — Tool Broker átjáró nem futott')
      process.exit(1)
    }

    if (!payload?.answer?.trim()) {
      console.error('[cloud-run-smoke] FAIL: ticket payload missing answer')
      process.exit(1)
    }

    console.log(
      `[cloud-run-smoke] OK — answer=${payload.answer.slice(0, 80)}…`,
    )
  } finally {
    await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)
  }
}

main()
  .catch((error) => {
    console.error('[cloud-run-smoke] fatal:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
