import { randomBytes } from 'crypto'
import { writeFile } from 'fs/promises'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const WIKI_AGENT_PROMPT = `Te az Excellence Pay belső tudás-asszisztense vagy.
Kizárólag a jóváhagyott belső tudásbázisra támaszkodva válaszolj.
Magyarul, tömören válaszolj, és minden lényegi állításhoz adj forráshivatkozást.
Ha nincs elég forrás, mondd ki, hogy nincs elég forrás.`

const INITIAL_MEMORY = `Excellence Pay belső tudásbázis - kezdő tartalom:
- Az MVP célja architektúra-teljes walking skeleton létrehozása.
- Az első lakó agent egy belső wiki-agent.
- A modellforrás kizárólag ChatGPT OAuth lehet.
- Minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.`

const KEY_FILE = path.join(process.cwd(), '.seed-demo-api-key')

async function ensureToolBrokerSeed(agentId: string) {
  const knowledgeBase = await prisma.connector.upsert({
    where: {
      type_name: {
        type: 'knowledge_base',
        name: 'Excellence Pay belső tudásbázis',
      },
    },
    create: {
      type: 'knowledge_base',
      name: 'Excellence Pay belső tudásbázis',
      scope: 'global',
      secretAlias: null,
      version: 1,
      config: { memoryBacked: true },
    },
    update: {
      config: { memoryBacked: true },
    },
  })

  const board = await prisma.connector.upsert({
    where: {
      type_name: {
        type: 'board',
        name: 'Control Plane Board',
      },
    },
    create: {
      type: 'board',
      name: 'Control Plane Board',
      scope: 'global',
      secretAlias: 'secret://control-plane-board/service-token',
      version: 1,
      config: { ticketStateMachine: true },
    },
    update: {
      config: { ticketStateMachine: true },
    },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: knowledgeBase.id } },
    create: { agentId, connectorId: knowledgeBase.id, accessMode: 'read' },
    update: { accessMode: 'read' },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: board.id } },
    create: { agentId, connectorId: board.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'kb_search' } },
    create: { agentId, toolName: 'kb_search', allowed: true },
    update: { allowed: true },
  })

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'board_write' } },
    create: { agentId, toolName: 'board_write', allowed: true },
    update: { allowed: true },
  })
}

const WIKI_RECIPE_CONTENT = {
  name: 'wiki-answer',
  version: 1,
  ticket_type: 'interaction',
  description: 'Belső tudásbázisból citált, magyar nyelvű választ ad.',
  parameters: ['ticket_id', 'agent_version'],
  instructions: [
    'Olvasd be a kérdést a ticket payloadból.',
    'Keress a tudásbázisban a kb_search eszközzel (max 6 találat).',
    'KIZÁRÓLAG a megtalált forrásokra támaszkodva válaszolj, magyarul, tömören.',
    'MINDEN állítás mellé tedd a forráshivatkozást (docId + szakasz).',
    'Ha a források nem fedik le a kérdést, mondd ki: "nincs elég forrás", és NE találj ki tényt.',
    'Írd vissza az eredményt a board_write eszközzel: { answer, sources[], rationale }.',
    'Ha a válasz kifelé menő vagy bizonytalan, a ticketet hagyd awaiting_human állapotban.',
  ],
  tools: ['kb_search', 'board_write'],
  output_schema: {
    answer: 'string',
    sources: '[{ docId: string, sectionRef: string }]',
    rationale: 'string',
    confidence: 'enum[high, medium, low]',
  },
}

// wiki-answer recipe (§6) — aktív v1, az agent aktuális verziójához kötve (reprodukálhatóság).
async function ensureWikiRecipe(agentId: string, approverId: string) {
  let recipe = await prisma.recipe.findFirst({ where: { name: 'wiki-answer' } })
  if (!recipe) {
    recipe = await prisma.recipe.create({
      data: {
        name: 'wiki-answer',
        ticketType: 'interaction',
        scope: 'single',
        versions: {
          create: {
            version: 1,
            content: WIKI_RECIPE_CONTENT,
            status: 'active',
            approvedById: approverId,
          },
        },
      },
    })
  }

  const activeVersion = await prisma.recipeVersion.findFirst({
    where: { recipeId: recipe.id, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!activeVersion) return

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) return

  await prisma.agentVersion.updateMany({
    where: { agentId, version: agent.currentVersion, recipeVersionId: null },
    data: { recipeVersionId: activeVersion.id },
  })
}

// Friss demó API-kulcs az agentnek + lokális fájlba írás (acceptance + kézi teszt).
async function ensureDemoApiKey(agentId: string) {
  const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
  await prisma.agentApiKey.create({
    data: {
      agentId,
      keyHash: await bcrypt.hash(rawKey, 10),
      scopes: ['ticket:read', 'ticket:create', 'tool:invoke'],
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

  const existingAgent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
  if (existingAgent) {
    console.log('Seed already applied (Wiki Agent exists) — demó API-kulcs frissítése')
    await ensureToolBrokerSeed(existingAgent.id)
    await ensureWikiRecipe(existingAgent.id, admin.id)
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
    provider: 'chatgpt-oauth',
    model: 'chatgpt-oauth-default',
    temperature: 0.2,
    maxTokens: 4096,
  }

  const agent = await prisma.agent.create({
    data: {
      name: 'Wiki Agent',
      roleDescription: 'Belső tudásbázisból citált válaszadás',
      systemPrompt: WIKI_AGENT_PROMPT,
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
      systemPromptSnapshot: WIKI_AGENT_PROMPT,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  const policy = await prisma.resource.create({
    data: {
      type: 'policy',
      name: 'Excellence Pay belső tudásbázis',
      scope: 'global',
      version: 1,
      dataRef: 'knowledge/excellence-pay-internal-v1.md',
    },
  })

  await prisma.agentResource.create({
    data: { agentId: agent.id, resourceId: policy.id, accessMode: 'read' },
  })

  await ensureToolBrokerSeed(agent.id)
  await ensureWikiRecipe(agent.id, admin.id)
  await ensureDemoApiKey(agent.id)

  console.log('Seed complete')
  console.log('  Wiki Agent:', agent.id)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
