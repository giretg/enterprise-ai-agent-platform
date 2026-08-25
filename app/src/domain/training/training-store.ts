import type {
  MemoryVersionKind,
  TrainingOrigin,
  TrainingProposalCompositionMode,
  TrainingProposalRevisionStatus,
  TrainingProposalTokenStatus,
  TrainingScopeClass,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export type InstructionVersionRow = {
  id: string
  memoryId: string
  version: number
  content: string | null
  status: string
  source: string | null
  approvedById: string | null
  parentVersion: number | null
  createdAt: Date
}

export type AgentTrainingContext = {
  id: string
  tenantId: string | null
  name: string
  currentVersion: number
  selfEvolutionProfile: unknown
  memoryId: string
  currentInstruction: InstructionVersionRow | null
}

export type TrainingMetaRow = {
  ticketId: string
  proposedDiff: unknown
  writeGateTokenRef: string | null
  evalResult: unknown
  evalRequired: boolean
  origin: TrainingOrigin
  scopeClass: TrainingScopeClass
  targetMemoryVersion: number
  currentRevisionId: string | null
}

export type RevisionRow = {
  id: string
  trainingTicketId: string
  revision: number
  baseVersionId: string
  proposedVersionRef: string
  changeSummary: unknown
  impactResult: unknown
  compositionMode: TrainingProposalCompositionMode
  status: TrainingProposalRevisionStatus
  targetMemoryVersion: number
  writeGateTokenRef: string | null
  tokenStatus: TrainingProposalTokenStatus
  tokenExpiresAt: Date | null
  createdById: string
  createdAt: Date
}

export interface TrainingStore {
  findAgentContext(agentId: string): Promise<AgentTrainingContext | null>
  nextInstructionVersion(memoryId: string): Promise<number>
  listInstructionVersions(memoryId: string, limit: number): Promise<InstructionVersionRow[]>
  findInstructionVersion(memoryId: string, version: number): Promise<InstructionVersionRow | null>
  findInstructionVersionById(id: string): Promise<InstructionVersionRow | null>
  findTrainingMeta(ticketId: string): Promise<TrainingMetaRow | null>
  createTrainingMeta(data: {
    ticketId: string
    proposedDiff: unknown
    targetMemoryVersion: number
    evalRequired: boolean
    origin: TrainingOrigin
    scopeClass: TrainingScopeClass
  }): Promise<void>
  updateTrainingMeta(
    ticketId: string,
    data: Partial<Pick<TrainingMetaRow, 'proposedDiff' | 'writeGateTokenRef' | 'evalResult' | 'currentRevisionId' | 'targetMemoryVersion'>>,
  ): Promise<void>
  listRevisions(ticketId: string): Promise<RevisionRow[]>
  findRevision(id: string): Promise<RevisionRow | null>
  createRevision(
    data: Omit<RevisionRow, 'id' | 'createdAt' | 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'> &
      Partial<Pick<RevisionRow, 'id' | 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'>>,
  ): Promise<RevisionRow>
  supersedeCurrentRevisions(ticketId: string): Promise<void>
  updateRevision(
    id: string,
    data: Partial<Pick<RevisionRow, 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'>>,
  ): Promise<void>
  createInstructionVersion(data: {
    memoryId: string
    version: number
    content: string
    diffFromPrevious: unknown
    source: string | null
    approvedById: string
    parentVersion: number | null
  }): Promise<InstructionVersionRow>
  setInstructionCurrent(params: {
    memoryId: string
    nextVersionId: string
    previousActiveId: string | null
  }): Promise<void>
  restoreInstructionVersion(params: {
    memoryId: string
    targetId: string
    previousActiveId: string | null
  }): Promise<void>
  findUser(id: string): Promise<{ id: string } | null>
}

function mapInstruction(row: {
  id: string
  memoryId: string
  version: number
  content: string | null
  status: string
  source: string | null
  approvedById: string | null
  parentVersion: number | null
  createdAt: Date
}): InstructionVersionRow {
  return {
    id: row.id,
    memoryId: row.memoryId,
    version: row.version,
    content: row.content,
    status: row.status,
    source: row.source,
    approvedById: row.approvedById,
    parentVersion: row.parentVersion,
    createdAt: row.createdAt,
  }
}

const INSTRUCTION: MemoryVersionKind = 'instruction'

export const prismaTrainingStore: TrainingStore = {
  async findAgentContext(agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        tenantId: true,
        name: true,
        currentVersion: true,
        selfEvolutionProfile: true,
        memoryId: true,
        memory: { select: { currentVersion: true } },
      },
    })
    if (!agent) return null
    const current = agent.memory.currentVersion
    return {
      id: agent.id,
      tenantId: agent.tenantId,
      name: agent.name,
      currentVersion: agent.currentVersion,
      selfEvolutionProfile: agent.selfEvolutionProfile,
      memoryId: agent.memoryId,
      currentInstruction:
        current && current.kind === INSTRUCTION
          ? mapInstruction(current)
          : current
            ? await prisma.memoryVersion.findFirst({
                where: { memoryId: agent.memoryId, kind: INSTRUCTION, status: 'active' },
                orderBy: { version: 'desc' },
              }).then((row) => (row ? mapInstruction(row) : null))
            : await prisma.memoryVersion.findFirst({
                where: { memoryId: agent.memoryId, kind: INSTRUCTION, status: 'active' },
                orderBy: { version: 'desc' },
              }).then((row) => (row ? mapInstruction(row) : null)),
    }
  },

  async nextInstructionVersion(memoryId) {
    const row = await prisma.memoryVersion.aggregate({
      where: { memoryId, kind: INSTRUCTION },
      _max: { version: true },
    })
    return (row._max.version ?? 0) + 1
  },

  async listInstructionVersions(memoryId, limit) {
    const rows = await prisma.memoryVersion.findMany({
      where: { memoryId, kind: INSTRUCTION },
      orderBy: { version: 'desc' },
      take: limit,
    })
    return rows.map(mapInstruction)
  },

  async findInstructionVersion(memoryId, version) {
    const row = await prisma.memoryVersion.findUnique({
      where: { memoryId_kind_version: { memoryId, kind: INSTRUCTION, version } },
    })
    return row ? mapInstruction(row) : null
  },

  async findInstructionVersionById(id) {
    const row = await prisma.memoryVersion.findUnique({ where: { id } })
    if (!row || row.kind !== INSTRUCTION) return null
    return mapInstruction(row)
  },

  async findTrainingMeta(ticketId) {
    return prisma.trainingTicket.findUnique({ where: { ticketId } })
  },

  async createTrainingMeta(data) {
    await prisma.trainingTicket.create({
      data: {
        ticketId: data.ticketId,
        proposedDiff: data.proposedDiff as Prisma.InputJsonValue,
        targetMemoryVersion: data.targetMemoryVersion,
        evalRequired: data.evalRequired,
        origin: data.origin,
        scopeClass: data.scopeClass,
        writeGateTokenRef: null,
      },
    })
  },

  async updateTrainingMeta(ticketId, data) {
    await prisma.trainingTicket.update({
      where: { ticketId },
      data: {
        ...(data.proposedDiff !== undefined
          ? { proposedDiff: data.proposedDiff as Prisma.InputJsonValue }
          : {}),
        ...(data.writeGateTokenRef !== undefined ? { writeGateTokenRef: data.writeGateTokenRef } : {}),
        ...(data.evalResult !== undefined
          ? { evalResult: data.evalResult as Prisma.InputJsonValue }
          : {}),
        ...(data.currentRevisionId !== undefined ? { currentRevisionId: data.currentRevisionId } : {}),
        ...(data.targetMemoryVersion !== undefined ? { targetMemoryVersion: data.targetMemoryVersion } : {}),
      },
    })
  },

  async listRevisions(ticketId) {
    return prisma.trainingProposalRevision.findMany({
      where: { trainingTicketId: ticketId },
      orderBy: { revision: 'asc' },
    })
  },

  async findRevision(id) {
    return prisma.trainingProposalRevision.findUnique({ where: { id } })
  },

  async createRevision(data) {
    return prisma.trainingProposalRevision.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        trainingTicketId: data.trainingTicketId,
        revision: data.revision,
        baseVersionId: data.baseVersionId,
        proposedVersionRef: data.proposedVersionRef,
        changeSummary: data.changeSummary as Prisma.InputJsonValue,
        impactResult: data.impactResult as Prisma.InputJsonValue,
        compositionMode: data.compositionMode,
        status: data.status ?? 'current',
        targetMemoryVersion: data.targetMemoryVersion,
        writeGateTokenRef: data.writeGateTokenRef ?? null,
        tokenStatus: data.tokenStatus ?? 'unissued',
        tokenExpiresAt: data.tokenExpiresAt ?? null,
        createdById: data.createdById,
      },
    })
  },

  async supersedeCurrentRevisions(ticketId) {
    await prisma.trainingProposalRevision.updateMany({
      where: { trainingTicketId: ticketId, status: 'current' },
      data: { status: 'superseded', tokenStatus: 'revoked' },
    })
  },

  async updateRevision(id, data) {
    await prisma.trainingProposalRevision.update({
      where: { id },
      data,
    })
  },

  async createInstructionVersion(data) {
    const row = await prisma.memoryVersion.create({
      data: {
        memoryId: data.memoryId,
        version: data.version,
        kind: INSTRUCTION,
        content: data.content,
        diffFromPrevious: data.diffFromPrevious as Prisma.InputJsonValue | undefined,
        status: 'active',
        source: data.source ?? undefined,
        approvedById: data.approvedById,
        parentVersion: data.parentVersion,
      },
    })
    return mapInstruction(row)
  },

  async setInstructionCurrent(params) {
    if (params.previousActiveId) {
      await prisma.memoryVersion.update({
        where: { id: params.previousActiveId },
        data: { status: 'rolled_back' },
      })
    }
    await prisma.memory.update({
      where: { id: params.memoryId },
      data: { currentVersionId: params.nextVersionId },
    })
  },

  async restoreInstructionVersion(params) {
    if (params.previousActiveId && params.previousActiveId !== params.targetId) {
      await prisma.memoryVersion.update({
        where: { id: params.previousActiveId },
        data: { status: 'rolled_back' },
      })
    }
    await prisma.memoryVersion.update({
      where: { id: params.targetId },
      data: { status: 'active' },
    })
    await prisma.memory.update({
      where: { id: params.memoryId },
      data: { currentVersionId: params.targetId },
    })
  },

  async findUser(id) {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } })
    return user
  },
}
