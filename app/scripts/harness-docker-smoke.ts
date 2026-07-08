/**
 * Harness completion callback Docker smoke — S4 / Epik 5 proof.
 * Előfeltétel: `docker build -f Dockerfile.harness -t wiki-harness:local .`
 * és futó platform (pl. npm run dev) host.docker.internal:3000-on.
 *
 * Futtatás: npm run harness:docker-smoke
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'
import {
  buildHarnessDockerArgs,
  readSeedApiKey,
  runDocker,
} from './harness-docker-shared'

const CALLBACK_TOKEN = process.env.HARNESS_CALLBACK_TOKEN ?? 'docker-smoke-secret'

async function main() {
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
      title: 'Docker harness smoke',
      state: 'in_progress',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: {
        question: 'Mi a platform célja?',
        agentVersion: agent.currentVersion,
      },
      lockToken,
      lockedAt: new Date(),
      createdById: operator.id,
      source: 'test',
    },
  })

  console.log(`[docker-smoke] ticket=${ticketId}`)

  const exitCode = await runDocker(
    buildHarnessDockerArgs({
      ticketId,
      agentId: agent.id,
      lockToken,
      harnessMode: 'callback-only',
      callbackToken: CALLBACK_TOKEN,
      extraEnv: {
        HARNESS_AGENT_API_KEY: agentApiKey,
        CHATGPT_OAUTH_PROVIDER_URL: 'stub',
        CHATGPT_OAUTH_PROVIDER_KEY: 'stub',
      },
    }),
  )

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
  console.log(`[docker-smoke] ticket state=${ticket?.state} lock=${ticket?.lockToken ?? 'null'}`)

  await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)

  if (exitCode !== 0) {
    console.error(`[docker-smoke] FAIL: docker exit ${exitCode}`)
    process.exit(exitCode)
  }

  if (ticket?.lockToken) {
    console.error('[docker-smoke] FAIL: lock not released after completion')
    process.exit(1)
  }

  console.log('[docker-smoke] OK')
}

main()
  .catch((error) => {
    console.error('[docker-smoke] fatal:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
