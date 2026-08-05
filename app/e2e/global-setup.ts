/**
 * Playwright global setup — W7 file editor UI teszt fixture.
 * Létrehoz egy in_progress ticketet és elmenti az ID-t az e2e teszteknek.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { prisma } from '../src/lib/db'

async function globalSetup() {
  process.env.FILE_EDITOR_STUB = 'true'
  process.env.FILE_EDITOR_STUB_MEMORY = 'true'

  const operator = await prisma.user.findFirst({
    where: { externalAuthId: process.env.DEV_AUTH_USER_ID ?? 'dev-user-001' },
  })
  if (!operator) {
    throw new Error('Dev operator user missing — futtasd: npm run db:seed')
  }

  const agent = await prisma.agent.findFirst({ where: { status: 'active' } })
  if (!agent) {
    throw new Error('Active agent missing — futtasd: npm run db:seed')
  }

  const ticket = await prisma.ticket.create({
    data: {
      type: 'interaction',
      title: 'E2E: file editor UI',
      state: 'in_progress',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: { task: 'file editor ui e2e' },
      createdById: operator.id,
    },
  })

  const fixtureDir = resolve(process.cwd(), 'e2e')
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(
    resolve(fixtureDir, '.fixture.json'),
    JSON.stringify({ ticketId: ticket.id, uploadFileName: 'e2e-upload.txt' }),
  )
}

export default globalSetup
