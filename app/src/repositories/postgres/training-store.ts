import { Prisma, type MemoryVersion, type MemoryVersionKind, type TrainingProposalRevision } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ChangeSummary, ImpactResult } from '@/domain/training/training-composition'
import type {
  InstructionVersionRow,
  RevisionRow,
  TrainingStore,
} from '@/domain/training/training-store'

const INSTRUCTION: MemoryVersionKind = 'instruction'

class InstructionVersionCasMiss extends Error {}
class RevisionClaimMiss extends Error {}

/** Aktiváláskor elfogadott ticket állapotok (claim + memory CAS előtt). */
const ACTIVATABLE_TICKET_STATES = new Set(['awaiting_human', 'approved', 'in_progress', 'ready'])

function mapInstruction(row: MemoryVersion): InstructionVersionRow {
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

function mapRevision(row: TrainingProposalRevision): RevisionRow {
  return {
    ...row,
    changeSummary: row.changeSummary as unknown as ChangeSummary,
    impactResult: row.impactResult as unknown as ImpactResult,
  }
}

export class PostgresTrainingStore implements TrainingStore {
  async findAgentContext(agentId: string) {
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

    const pointedVersion = agent.memory.currentVersion
    const currentInstruction =
      pointedVersion?.kind === INSTRUCTION
        ? pointedVersion
        : await prisma.memoryVersion.findFirst({
            where: { memoryId: agent.memoryId, kind: INSTRUCTION, status: 'active' },
            orderBy: { version: 'desc' },
          })

    return {
      id: agent.id,
      tenantId: agent.tenantId,
      name: agent.name,
      currentVersion: agent.currentVersion,
      selfEvolutionProfile: agent.selfEvolutionProfile,
      memoryId: agent.memoryId,
      currentInstruction: currentInstruction ? mapInstruction(currentInstruction) : null,
    }
  }

  async nextInstructionVersion(memoryId: string) {
    const row = await prisma.memoryVersion.aggregate({
      where: { memoryId, kind: INSTRUCTION },
      _max: { version: true },
    })
    return (row._max.version ?? 0) + 1
  }

  async listInstructionVersions(memoryId: string, limit: number) {
    const rows = await prisma.memoryVersion.findMany({
      where: { memoryId, kind: INSTRUCTION },
      orderBy: { version: 'desc' },
      take: limit,
    })
    return rows.map(mapInstruction)
  }

  async findInstructionVersion(memoryId: string, version: number) {
    const row = await prisma.memoryVersion.findUnique({
      where: { memoryId_kind_version: { memoryId, kind: INSTRUCTION, version } },
    })
    return row ? mapInstruction(row) : null
  }

  async findTrainingMeta(ticketId: string) {
    return prisma.trainingTicket.findUnique({ where: { ticketId } })
  }

  async createTrainingMeta(data: Parameters<TrainingStore['createTrainingMeta']>[0]) {
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
  }

  async updateTrainingMeta(
    ticketId: string,
    data: Parameters<TrainingStore['updateTrainingMeta']>[1],
  ) {
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
  }

  async listRevisions(ticketId: string) {
    const rows = await prisma.trainingProposalRevision.findMany({
      where: { trainingTicketId: ticketId },
      orderBy: { revision: 'asc' },
    })
    return rows.map(mapRevision)
  }

  async findRevision(id: string) {
    const row = await prisma.trainingProposalRevision.findUnique({ where: { id } })
    return row ? mapRevision(row) : null
  }

  async createRevision(data: Parameters<TrainingStore['createRevision']>[0]) {
    const row = await prisma.trainingProposalRevision.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        trainingTicketId: data.trainingTicketId,
        revision: data.revision,
        baseVersionId: data.baseVersionId,
        proposedVersionRef: data.proposedVersionRef,
        changeSummary: data.changeSummary as unknown as Prisma.InputJsonValue,
        impactResult: data.impactResult as unknown as Prisma.InputJsonValue,
        compositionMode: data.compositionMode,
        status: data.status ?? 'current',
        targetMemoryVersion: data.targetMemoryVersion,
        writeGateTokenRef: data.writeGateTokenRef ?? null,
        tokenStatus: data.tokenStatus ?? 'unissued',
        tokenExpiresAt: data.tokenExpiresAt ?? null,
        createdById: data.createdById,
      },
    })
    return mapRevision(row)
  }

  async supersedeCurrentRevisions(ticketId: string) {
    await prisma.trainingProposalRevision.updateMany({
      where: { trainingTicketId: ticketId, status: 'current' },
      data: { status: 'superseded', tokenStatus: 'revoked' },
    })
  }

  async updateRevision(
    id: string,
    data: Parameters<TrainingStore['updateRevision']>[1],
  ) {
    await prisma.trainingProposalRevision.update({ where: { id }, data })
  }

  async activateInstructionVersion(data: Parameters<TrainingStore['activateInstructionVersion']>[0]) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.memoryVersion.create({
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
        const claimed = await tx.memory.updateMany({
          where: {
            id: data.memoryId,
            currentVersionId: data.expectedCurrentVersionId,
          },
          data: { currentVersionId: created.id },
        })
        if (claimed.count !== 1) throw new InstructionVersionCasMiss()

        if (data.expectedCurrentVersionId) {
          await tx.memoryVersion.update({
            where: { id: data.expectedCurrentVersionId },
            data: { status: 'rolled_back' },
          })
        }
        return created
      })
      return mapInstruction(row)
    } catch (error) {
      if (
        error instanceof InstructionVersionCasMiss ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ) {
        return null
      }
      throw error
    }
  }

  async claimRevisionAndActivateInstruction(
    data: Parameters<TrainingStore['claimRevisionAndActivateInstruction']>[0],
  ) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findUnique({
          where: { id: data.ticketId },
          select: { state: true, type: true },
        })
        if (!ticket || ticket.type !== 'training') throw new RevisionClaimMiss()
        // Rejected/done/cancelled ticketen ne aktiváljunk — a claim a memory írással együtt atomikus.
        if (!ACTIVATABLE_TICKET_STATES.has(ticket.state)) throw new RevisionClaimMiss()

        const meta = await tx.trainingTicket.findUnique({ where: { ticketId: data.ticketId } })
        if (!meta || meta.currentRevisionId !== data.revisionId) throw new RevisionClaimMiss()

        const revisionClaim = await tx.trainingProposalRevision.updateMany({
          where: {
            id: data.revisionId,
            trainingTicketId: data.ticketId,
            status: 'current',
            tokenStatus: { in: ['unissued', 'issued'] },
          },
          data: {
            tokenStatus: 'consumed',
            writeGateTokenRef: data.writeGateTokenRef,
          },
        })
        if (revisionClaim.count !== 1) throw new RevisionClaimMiss()

        await tx.trainingTicket.update({
          where: { ticketId: data.ticketId },
          data: { writeGateTokenRef: data.writeGateTokenRef },
        })

        const created = await tx.memoryVersion.create({
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
        const pointerClaim = await tx.memory.updateMany({
          where: {
            id: data.memoryId,
            currentVersionId: data.expectedCurrentVersionId,
          },
          data: { currentVersionId: created.id },
        })
        if (pointerClaim.count !== 1) throw new InstructionVersionCasMiss()

        if (data.expectedCurrentVersionId) {
          await tx.memoryVersion.update({
            where: { id: data.expectedCurrentVersionId },
            data: { status: 'rolled_back' },
          })
        }
        return created
      })
      return { ok: true as const, version: mapInstruction(row) }
    } catch (error) {
      if (error instanceof RevisionClaimMiss) {
        return { ok: false as const, reason: 'stale_revision' as const }
      }
      if (
        error instanceof InstructionVersionCasMiss ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ) {
        return { ok: false as const, reason: 'base_version_stale' as const }
      }
      throw error
    }
  }

  async restoreInstructionVersion(params: Parameters<TrainingStore['restoreInstructionVersion']>[0]) {
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.memory.updateMany({
          where: {
            id: params.memoryId,
            currentVersionId: params.expectedCurrentVersionId,
          },
          data: { currentVersionId: params.targetId },
        })
        if (claimed.count !== 1) throw new InstructionVersionCasMiss()

        if (
          params.expectedCurrentVersionId &&
          params.expectedCurrentVersionId !== params.targetId
        ) {
          await tx.memoryVersion.update({
            where: { id: params.expectedCurrentVersionId },
            data: { status: 'rolled_back' },
          })
        }
        await tx.memoryVersion.update({
          where: { id: params.targetId },
          data: { status: 'active' },
        })
      })
      return true
    } catch (error) {
      if (error instanceof InstructionVersionCasMiss) return false
      throw error
    }
  }

  async findUser(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true } })
  }
}
