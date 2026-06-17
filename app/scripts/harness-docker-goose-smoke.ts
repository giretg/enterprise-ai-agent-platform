/**
 * Goose harness Docker smoke — S1/S2/S3 Epik 5 proof.
 * Előfeltétel:
 *   docker build -f Dockerfile.harness -t wiki-harness:local .
 *   npm run dev (platform host.docker.internal:3000-on elérhető)
 *   HARNESS_CALLBACK_TOKEN egyezik a platform .env.local-lel
 *
 * Futtatás: npm run harness:docker-goose-smoke
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'
import {
  buildHarnessDockerArgs,
  dockerImageExists,
  isPlatformReachable,
  platformBaseUrl,
  readSeedApiKey,
  runDocker,
} from './harness-docker-shared'

const IMAGE = process.env.HARNESS_DOCKER_IMAGE ?? 'wiki-harness:local'
const SAMPLE_QUESTION =
  'Mi az MVP célja, és milyen átjárókon kell átmennie az agent műveleteinek?'

async function main() {
  if (!(await dockerImageExists(IMAGE))) {
    console.error(`[docker-goose-smoke] FAIL: image not found (${IMAGE})`)
    console.error('Build: docker build -f Dockerfile.harness -t wiki-harness:local .')
    process.exit(1)
  }

  const platformUrl = platformBaseUrl()
  if (!(await isPlatformReachable(platformUrl))) {
    console.error(`[docker-goose-smoke] FAIL: platform not reachable at ${platformUrl}`)
    console.error('Start: npm run dev')
    process.exit(1)
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
      title: 'Docker goose harness smoke',
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
      source: 'test',
    },
  })

  console.log(`[docker-goose-smoke] ticket=${ticketId}`)
  console.log(`[docker-goose-smoke] platform=${platformUrl}`)
  console.log(`[docker-goose-smoke] image=${IMAGE}`)

  const dockerArgs = buildHarnessDockerArgs({
    ticketId,
    agentId: agent.id,
    lockToken,
    agentVersion: agent.currentVersion,
    question: SAMPLE_QUESTION,
    harnessMode: 'goose',
    extraEnv: { HARNESS_AGENT_API_KEY: agentApiKey },
  })

  const exitCode = await runDocker(dockerArgs)

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
  const payload = ticket?.payload as { answer?: string; confidence?: string } | null
  const modelCalls = await prisma.modelCall.count({ where: { ticketId } })
  const toolCalls = await prisma.toolCall.count({ where: { ticketId } })

  console.log(
    `[docker-goose-smoke] state=${ticket?.state} lock=${ticket?.lockToken ?? 'null'} modelCalls=${modelCalls} toolCalls=${toolCalls}`,
  )

  await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)

  if (exitCode !== 0) {
    console.error(`[docker-goose-smoke] FAIL: docker exit ${exitCode}`)
    process.exit(exitCode)
  }

  if (ticket?.lockToken) {
    console.error('[docker-goose-smoke] FAIL: lock not released after completion callback')
    process.exit(1)
  }

  if (modelCalls === 0) {
    console.error('[docker-goose-smoke] FAIL: no model_calls — Gateway átjáró nem futott')
    process.exit(1)
  }

  if (toolCalls === 0) {
    console.error('[docker-goose-smoke] FAIL: no tool_calls — Tool Broker átjáró nem futott')
    process.exit(1)
  }

  if (!payload?.answer?.trim()) {
    console.error('[docker-goose-smoke] FAIL: ticket payload missing answer (board_write?)')
    process.exit(1)
  }

  console.log(
    `[docker-goose-smoke] OK — answer=${payload.answer.slice(0, 80)}… confidence=${payload.confidence ?? 'n/a'}`,
  )
}

main()
  .catch((error) => {
    console.error('[docker-goose-smoke] fatal:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
