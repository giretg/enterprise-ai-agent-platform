import type { Agent, Document, Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import { selfEvolutionProfileSchema } from '@/lib/self-evolution-profile'
import type { AgentRepository, DocumentRepository } from '../interfaces'

export class PostgresAgentRepository implements AgentRepository {
  async findMany(): Promise<Agent[]> {
    return prisma.agent.findMany({ orderBy: { createdAt: 'desc' } })
  }

  async findById(id: string): Promise<Agent | null> {
    return prisma.agent.findUnique({ where: { id } })
  }

  async findByIdWithDetails(id: string) {
    const agent = await prisma.agent.findUnique({
      where: { id },
      include: {
        memory: {
          include: {
            currentVersion: true,
            versions: { orderBy: { version: 'desc' }, take: 5 },
          },
        },
        agentResources: { include: { resource: true } },
        apiKeys: { where: { status: 'active' }, take: 1 },
      },
    })

    if (!agent) return null

    // A reprodukálhatósághoz (§5.3): az aktuális agent-verzióhoz fagyasztott recipe.
    const currentAgentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
      include: { recipeVersion: { include: { recipe: true } } },
    })
    const recipeVersion = currentAgentVersion?.recipeVersion ?? null

    return {
      agent,
      memoryContent: agent.memory.currentVersion?.content ?? null,
      memoryVersion: agent.memory.currentVersion?.version ?? null,
      recipe: recipeVersion
        ? {
            name: recipeVersion.recipe.name,
            ticketType: recipeVersion.recipe.ticketType,
            version: recipeVersion.version,
            status: recipeVersion.status,
          }
        : null,
      resources: agent.agentResources.map((ar) => ({
        id: ar.resource.id,
        name: ar.resource.name,
        type: ar.resource.type,
        scope: ar.resource.scope,
        version: ar.resource.version,
        accessMode: ar.accessMode,
      })),
      apiKeyPreview: agent.apiKeys[0] ? 'cp_sk_•••••••• (scoped)' : null,
    }
  }

  async findVersionSnapshot(agentId: string, version: number) {
    const agentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId, version } },
      include: {
        recipeVersion: { include: { recipe: true } },
        memoryVersion: true,
      },
    })
    if (!agentVersion) return null

    return {
      agentVersion: agentVersion.version,
      roleInstruction: agentVersion.roleInstructionSnapshot,
      behaviorProfile: agentVersion.behaviorProfileSnapshot,
      roleInstructionVersion: agentVersion.roleInstructionVersion,
      behaviorProfileVersion: agentVersion.behaviorProfileVersion,
      memoryVersion: agentVersion.memoryVersion?.version ?? null,
      model: agentVersion.modelConfigSnapshot,
      recipe: agentVersion.recipeVersion
        ? {
            name: agentVersion.recipeVersion.recipe.name,
            version: agentVersion.recipeVersion.version,
            status: agentVersion.recipeVersion.status,
          }
        : null,
    }
  }

  async create(input: {
    name: string
    roleInstruction: string
    behaviorProfile: string
    modelConfig: Agent['modelConfig']
    role?: Agent['role']
    selfEvolutionProfile?: Agent['selfEvolutionProfile']
    initialMemory?: string
    createdById: string
  }) {
    const memory = await prisma.memory.create({ data: {} })

    const memoryVersion = await prisma.memoryVersion.create({
      data: {
        memoryId: memory.id,
        version: 1,
        content: input.initialMemory ?? '',
        status: 'active',
        source: 'createAgent',
        approvedById: input.createdById,
      },
    })

    await prisma.memory.update({
      where: { id: memory.id },
      data: { currentVersionId: memoryVersion.id },
    })

    const agentRole = input.role ?? 'worker'
    const selfEvolutionProfile = input.selfEvolutionProfile
      ? (selfEvolutionProfileSchema.parse(input.selfEvolutionProfile) as Prisma.InputJsonValue)
      : undefined

    const agent = await prisma.agent.create({
      data: {
        name: input.name,
        roleInstruction: input.roleInstruction,
        behaviorProfile: input.behaviorProfile,
        modelConfig: input.modelConfig as Prisma.InputJsonValue,
        status: 'active',
        role: agentRole,
        selfEvolutionProfile,
        currentVersion: 1,
        currentRoleInstructionVersion: 1,
        currentBehaviorProfileVersion: 1,
        memoryId: memory.id,
      },
    })

    await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        version: 1,
        roleInstructionSnapshot: input.roleInstruction,
        behaviorProfileSnapshot: input.behaviorProfile,
        roleInstructionVersion: 1,
        behaviorProfileVersion: 1,
        modelConfigSnapshot: input.modelConfig as Prisma.InputJsonValue,
        memoryVersionId: memoryVersion.id,
      },
    })

    const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
    await prisma.agentApiKey.create({
      data: {
        agentId: agent.id,
        keyHash: await bcrypt.hash(rawKey, 10),
        scopes: ['ticket:read', 'ticket:create', 'tool:invoke'],
        status: 'active',
      },
    })

    const board = await prisma.connector.findFirst({
      where: { type: 'board', name: 'Control Plane Board' },
    })
    if (board) {
      await prisma.agentConnector.upsert({
        where: { agentId_connectorId: { agentId: agent.id, connectorId: board.id } },
        create: { agentId: agent.id, connectorId: board.id, accessMode: 'write' },
        update: { accessMode: 'write' },
      })
    }

    for (const toolName of ['ticket_create', 'agent_ask', 'agent_resolve', 'agent_catalog']) {
      await prisma.capability.upsert({
        where: { agentId_toolName: { agentId: agent.id, toolName } },
        create: { agentId: agent.id, toolName, allowed: true },
        update: { allowed: true },
      })
    }

    await ensureAgentKnowledgeBase(agent)

    return { agent, apiKey: rawKey }
  }

  async updateInstruction(input: {
    agentId: string
    roleInstruction?: string
    behaviorProfile?: string
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    const nextRole = input.roleInstruction ?? agent.roleInstruction
    const nextBehavior = input.behaviorProfile ?? agent.behaviorProfile
    const roleChanged = nextRole !== agent.roleInstruction
    const behaviorChanged = nextBehavior !== agent.behaviorProfile

    if (!roleChanged && !behaviorChanged) {
      throw new Error('No instruction change provided')
    }

    // A reprodukálhatósághoz az új snapshot örökli az aktuális agent-verzió
    // memória- és recipe-kötését (§5.3).
    const currentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })
    if (!currentVersion) throw new Error('Current agent version snapshot missing')

    const nextRoleVersion = agent.currentRoleInstructionVersion + (roleChanged ? 1 : 0)
    const nextBehaviorVersion = agent.currentBehaviorProfileVersion + (behaviorChanged ? 1 : 0)
    const nextAgentVersion = agent.currentVersion + 1

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: nextRole,
          behaviorProfileSnapshot: nextBehavior,
          roleInstructionVersion: nextRoleVersion,
          behaviorProfileVersion: nextBehaviorVersion,
          modelConfigSnapshot: currentVersion.modelConfigSnapshot as Prisma.InputJsonValue,
          memoryVersionId: currentVersion.memoryVersionId,
          recipeVersionId: currentVersion.recipeVersionId,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          roleInstruction: nextRole,
          behaviorProfile: nextBehavior,
          currentVersion: nextAgentVersion,
          currentRoleInstructionVersion: nextRoleVersion,
          currentBehaviorProfileVersion: nextBehaviorVersion,
        },
      }),
    ])

    return {
      agentVersion: nextAgentVersion,
      roleInstructionVersion: nextRoleVersion,
      behaviorProfileVersion: nextBehaviorVersion,
      roleChanged,
      behaviorChanged,
    }
  }

  async updateModelConfig(input: { agentId: string; modelConfig: Agent['modelConfig'] }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    // Új snapshot örökli az aktuális szerep/viselkedés al-verziókat, memória- és
    // recipe-kötést; csak a modell-konfig változik (reprodukálhatóság).
    const currentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })
    if (!currentVersion) throw new Error('Current agent version snapshot missing')

    const nextAgentVersion = agent.currentVersion + 1

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: agent.roleInstruction,
          behaviorProfileSnapshot: agent.behaviorProfile,
          roleInstructionVersion: agent.currentRoleInstructionVersion,
          behaviorProfileVersion: agent.currentBehaviorProfileVersion,
          modelConfigSnapshot: input.modelConfig as Prisma.InputJsonValue,
          memoryVersionId: currentVersion.memoryVersionId,
          recipeVersionId: currentVersion.recipeVersionId,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          modelConfig: input.modelConfig as Prisma.InputJsonValue,
          currentVersion: nextAgentVersion,
        },
      }),
    ])

    return { agentVersion: nextAgentVersion }
  }

  async updateSelfEvolutionProfile(input: {
    agentId: string
    profile: Agent['selfEvolutionProfile']
  }) {
    const parsed = selfEvolutionProfileSchema.parse(input.profile)
    return prisma.agent.update({
      where: { id: input.agentId },
      data: { selfEvolutionProfile: parsed as Prisma.InputJsonValue },
    })
  }

  async delete(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')

    const memoryId = agent.memoryId

    await prisma.$transaction(async (tx) => {
      await tx.ticket.updateMany({
        where: { agentId },
        data: { agentId: null },
      })
      await tx.ticket.updateMany({
        where: { assigneeType: 'agent', assigneeId: agentId },
        data: { assigneeType: null, assigneeId: null },
      })
      await tx.toolCall.deleteMany({ where: { agentId } })
      await tx.modelCall.deleteMany({ where: { agentId } })
      await tx.agent.delete({ where: { id: agentId } })
      await tx.memory.update({
        where: { id: memoryId },
        data: { currentVersionId: null },
      })
      await tx.memoryVersion.deleteMany({ where: { memoryId } })
      await tx.memory.delete({ where: { id: memoryId } })
    })

    return { id: agent.id, name: agent.name }
  }

  async authenticateApiKey(rawKey: string) {
    if (!rawKey.startsWith('cp_sk_')) return null

    const activeKeys = await prisma.agentApiKey.findMany({
      where: { status: 'active' },
      select: { agentId: true, keyHash: true, scopes: true, id: true },
    })

    for (const key of activeKeys) {
      if (await bcrypt.compare(rawKey, key.keyHash)) {
        await prisma.agentApiKey.update({
          where: { id: key.id },
          data: { lastUsedAt: new Date() },
        })
        return {
          agentId: key.agentId,
          scopes: key.scopes as string[],
        }
      }
    }

    return null
  }
}

export class PostgresDocumentRepository implements DocumentRepository {
  async findById(id: string): Promise<Document | null> {
    return prisma.document.findUnique({ where: { id } })
  }

  async findByConnectorId(connectorId: string): Promise<Document[]> {
    return prisma.document.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(data: Omit<Document, 'id' | 'createdAt'>): Promise<Document> {
    return prisma.document.create({ data })
  }

  async update(
    id: string,
    data: Partial<Pick<Document, 'status' | 'extractedText' | 'connectorId'>>,
  ): Promise<Document> {
    return prisma.document.update({ where: { id }, data })
  }

  async delete(id: string): Promise<void> {
    await prisma.document.delete({ where: { id } })
  }
}
