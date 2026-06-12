import { randomBytes } from 'crypto'
import { writeFile } from 'fs/promises'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const BOOKKEEPER_PROMPT = `Te a Ostoros-Novaj Agrár Kft. könyvelő asszisztense vagy.
Feladatod beszállítói számlák feldolgozása: mezők kinyerése, főkönyvi szám és költséghely javaslata.
Soha ne könyvelj automatikusan — mindig hozz létre jóváhagyási tickettet.
A memóriában szereplő szabályokat kötelezően alkalmazd.`

const INITIAL_MEMORY = `Szállítói szabályok:
- AgroParts Kft.: alapértelmezett főkönyvi szám 5120 (karbantartási költség), kivéve ha a számla tartalma egyértelműen input anyag.
- Vetőmag Kft.: 5111, költséghely MG-001.
- ÁFA kulcsok: 27% (általános), 5% (mezőgazdasági input).`

const KEY_FILE = path.join(process.cwd(), '.seed-demo-api-key')

// Friss demó API-kulcs az agentnek + lokális fájlba írás (acceptance + kézi teszt).
async function ensureDemoApiKey(agentId: string) {
  const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
  await prisma.agentApiKey.create({
    data: {
      agentId,
      keyHash: await bcrypt.hash(rawKey, 10),
      scopes: ['ticket:read', 'ticket:create'],
      status: 'active',
    },
  })
  await writeFile(KEY_FILE, rawKey, 'utf8')
  console.log('  Demo API key (dev only): saved to .seed-demo-api-key')
}

async function main() {
  const admin = await prisma.user.upsert({
    where: { externalAuthId: 'seed-admin' },
    create: {
      externalAuthId: 'seed-admin',
      email: 'admin@excellence.ai',
      name: 'Platform Admin',
      role: 'admin',
    },
    update: {},
  })

  const approver = await prisma.user.upsert({
    where: { externalAuthId: 'seed-approver' },
    create: {
      externalAuthId: 'seed-approver',
      email: 'approver@excellence.ai',
      name: 'Kovács Anna',
      role: 'approver',
    },
    update: {},
  })

  const operator = await prisma.user.upsert({
    where: { externalAuthId: 'seed-operator' },
    create: {
      externalAuthId: 'seed-operator',
      email: 'operator@excellence.ai',
      name: 'Nagy Péter',
      role: 'operator',
    },
    update: {},
  })

  void admin
  void approver
  void operator

  const existingAgent = await prisma.agent.findFirst({ where: { name: 'Könyvelő Agent' } })
  if (existingAgent) {
    console.log('Seed already applied (Könyvelő Agent exists) — demó API-kulcs frissítése')
    await ensureDemoApiKey(existingAgent.id)
    return
  }

  const memory = await prisma.memory.create({ data: {} })

  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: INITIAL_MEMORY,
      status: 'active',
      source: 'seed',
      approvedById: admin.id,
    },
  })

  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    temperature: 0.2,
    maxTokens: 4096,
  }

  const agent = await prisma.agent.create({
    data: {
      name: 'Könyvelő Agent',
      roleDescription: 'Beszállítói számlák feldolgozása és könyvelési javaslat',
      systemPrompt: BOOKKEEPER_PROMPT,
      modelConfig,
      status: 'active',
      currentVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      systemPromptSnapshot: BOOKKEEPER_PROMPT,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  const policy = await prisma.resource.create({
    data: {
      type: 'policy',
      name: 'Számlajóváhagyási szabályzat',
      scope: 'global',
      version: 1,
      dataRef: 'policies/invoice-approval-v1.md',
    },
  })

  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: policy.id, accessMode: 'read' },
  })

  await ensureDemoApiKey(agent.id)

  console.log('Seed complete')
  console.log('  Könyvelő Agent:', agent.id)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
