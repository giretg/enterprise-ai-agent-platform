import type { Prisma } from '@prisma/client'
import { canOperateAgent } from '@/domain/agent-definition'
import {
  conversationSkillRecord,
  type ConversationSkillDraft,
  type ConversationSkillPorts,
  type OpenConversationSkillProposal,
} from '@/domain/skill/conversation-skill'
import { writeAudit } from '@/lib/audit/types'
import { prisma } from '@/lib/db'
import { parseSkillAttachments } from '@/lib/skill/skill-attachments'
import { parseSkillContent, parseSkillRequires } from '@/lib/skill/skill-content'
import { computeSkillContentHash } from '@/lib/skill/skill-content-hash'
import { repositories } from './index'

type Db = Prisma.TransactionClient | typeof prisma

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}

// ponytail: az aktív skill neve check-then-insert, unique index nélkül (a státusz a verzión van).
// Két párhuzamos admin-hívás ugyanarra a névre mindkettő írhat. Partial unique, ha ez előjön.
async function nameTaken(
  db: Db,
  input: { tenantId: string; name: string; exceptProposalId?: string },
): Promise<boolean> {
  const active = await db.skill.findFirst({
    where: {
      tenantId: input.tenantId,
      name: { equals: input.name.trim(), mode: 'insensitive' },
      versions: { some: { status: 'active' } },
    },
    select: { id: true },
  })
  if (active) return true
  const open = await db.conversationSkillProposal.findFirst({
    where: {
      tenantId: input.tenantId,
      status: 'open',
      name: { equals: input.name.trim(), mode: 'insensitive' },
      ...(input.exceptProposalId ? { id: { not: input.exceptProposalId } } : {}),
    },
    select: { id: true },
  })
  return Boolean(open)
}

async function insertLiveSkill(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    userId: string
    agentId: string
    draft: ConversationSkillDraft
  },
): Promise<string> {
  const marker = conversationSkillRecord()
  const contentHash = computeSkillContentHash(
    input.draft.content,
    input.draft.requires,
    input.draft.attachments,
  )
  const skill = await tx.skill.create({
    data: {
      name: input.draft.name,
      description: input.draft.description,
      catalogScope: marker.catalogScope,
      tenantId: input.tenantId,
      kind: marker.kind,
      producesSkills: marker.producesSkills,
      sourceType: 'authored',
      provenance: { origin: 'authored', via: 'conversation' },
      license: null,
      riskTier: input.draft.riskTier,
    },
  })
  const version = await tx.skillVersion.create({
    data: {
      skillId: skill.id,
      version: 1,
      content: input.draft.content as unknown as Prisma.InputJsonValue,
      requires: input.draft.requires as unknown as Prisma.InputJsonValue,
      ...(input.draft.attachments.length > 0
        ? { attachments: input.draft.attachments as unknown as Prisma.InputJsonValue }
        : {}),
      contentHash,
      status: 'active',
      approvedById: input.userId,
    },
  })
  await tx.agentSkill.create({
    data: {
      agentId: input.agentId,
      skillVersionId: version.id,
      enabled: true,
      assignedById: input.userId,
    },
  })
  return skill.id
}

function toOpen(row: {
  id: string
  tenantId: string
  agentId: string
  requestedById: string
  name: string
  description: string
  content: Prisma.JsonValue
  requires: Prisma.JsonValue
  attachments: Prisma.JsonValue | null
}): OpenConversationSkillProposal {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    requestedById: row.requestedById,
    name: row.name,
    description: row.description,
    content: parseSkillContent(row.content),
    requires: parseSkillRequires(row.requires),
    attachments: parseSkillAttachments(row.attachments),
  }
}

export function buildConversationSkillPorts(): ConversationSkillPorts {
  return {
    async agentUsable(input) {
      const agent = await repositories.agents.findById(input.agentId, input.tenantId)
      if (!agent || agent.tenantId !== input.tenantId) return false
      const grant = await repositories.resourceGrants.findAgentGrant({
        tenantId: input.tenantId,
        userId: input.userId,
        agentId: input.agentId,
      })
      return canOperateAgent({ role: input.role, grant, assumed: input.assumed })
    },
    async producerEnabled(input) {
      const row = await prisma.agentSkill.findFirst({
        where: {
          agentId: input.agentId,
          enabled: true,
          skillVersion: {
            status: 'active',
            skill: { producesSkills: true, tenantId: input.tenantId },
          },
        },
        select: { agentId: true },
      })
      return Boolean(row)
    },
    async allowedToolNames(agentId) {
      const caps = await repositories.agents.findCapabilitiesForAgent(agentId)
      return caps.filter((cap) => cap.allowed).map((cap) => cap.toolName)
    },
    async openProposalId(input) {
      const row = await prisma.conversationSkillProposal.findFirst({
        where: {
          tenantId: input.tenantId,
          agentId: input.agentId,
          requestedById: input.userId,
          status: 'open',
        },
        select: { id: true },
      })
      return row?.id ?? null
    },
    nameTaken: (input) => nameTaken(prisma, input),
    async createLive(input) {
      return prisma.$transaction(async (tx) => {
        if (await nameTaken(tx, { tenantId: input.tenantId, name: input.draft.name })) {
          return { ok: false, reason: 'name_taken' }
        }
        const skillId = await insertLiveSkill(tx, input)
        return { ok: true, skillId }
      })
    },
    async upsertOpen(input) {
      const write = (overwritten: boolean) =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.conversationSkillProposal.findFirst({
            where: {
              tenantId: input.tenantId,
              agentId: input.agentId,
              requestedById: input.userId,
              status: 'open',
            },
          })
          if (
            await nameTaken(tx, {
              tenantId: input.tenantId,
              name: input.draft.name,
              exceptProposalId: existing?.id,
            })
          ) {
            return { ok: false as const, reason: 'name_taken' as const }
          }
          const data = {
            name: input.draft.name,
            description: input.draft.description,
            content: input.draft.content as unknown as Prisma.InputJsonValue,
            requires: input.draft.requires as unknown as Prisma.InputJsonValue,
            attachments: input.draft.attachments as unknown as Prisma.InputJsonValue,
          }
          if (existing) {
            await tx.conversationSkillProposal.update({ where: { id: existing.id }, data })
            return { ok: true as const, proposalId: existing.id, overwritten: true }
          }
          if (overwritten) return { ok: false as const, reason: 'name_taken' as const }
          const created = await tx.conversationSkillProposal.create({
            data: {
              ...data,
              tenantId: input.tenantId,
              agentId: input.agentId,
              requestedById: input.userId,
              status: 'open',
            },
          })
          return { ok: true as const, proposalId: created.id, overwritten: false }
        })
      try {
        return await write(false)
      } catch (err) {
        // A nyitott javaslat unique indexe közben létrejött sor: a második hívás felülír.
        // Névütközésnél a második tranzakció is unique-ra fut, és semmi nem íródik.
        if (!isUniqueViolation(err)) throw err
        try {
          return await write(true)
        } catch (retryErr) {
          if (!isUniqueViolation(retryErr)) throw retryErr
          return { ok: false, reason: 'name_taken' }
        }
      }
    },
    async getOpen(input) {
      const row = await prisma.conversationSkillProposal.findFirst({
        where: { id: input.proposalId, tenantId: input.tenantId, status: 'open' },
      })
      return row ? toOpen(row) : null
    },
    async updateOpen(input) {
      const existing = await prisma.conversationSkillProposal.findFirst({
        where: { id: input.proposalId, tenantId: input.tenantId, status: 'open' },
      })
      if (!existing) return false
      const content = parseSkillContent(existing.content)
      await prisma.conversationSkillProposal.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          description: input.description,
          content: {
            ...content,
            instructions: input.content.instructions,
          } as unknown as Prisma.InputJsonValue,
        },
      })
      return true
    },
    async commitApproval(input) {
      return prisma.$transaction(async (tx) => {
        const proposal = await tx.conversationSkillProposal.findFirst({
          where: { id: input.proposalId, tenantId: input.tenantId, status: 'open' },
        })
        if (!proposal) return { ok: false as const, reason: 'not_open' as const }
        if (
          await nameTaken(tx, {
            tenantId: input.tenantId,
            name: input.draft.name,
            exceptProposalId: proposal.id,
          })
        ) {
          return { ok: false as const, reason: 'name_taken' as const }
        }
        const skillId = await insertLiveSkill(tx, {
          tenantId: input.tenantId,
          userId: input.adminId,
          agentId: proposal.agentId,
          draft: input.draft,
        })
        await tx.conversationSkillProposal.update({
          where: { id: proposal.id },
          data: {
            status: 'approved',
            skillId,
            decidedById: input.adminId,
            decidedAt: new Date(),
            name: input.draft.name,
            description: input.draft.description,
            content: input.draft.content as unknown as Prisma.InputJsonValue,
          },
        })
        return { ok: true as const, skillId, agentId: proposal.agentId }
      })
    },
    async rejectOpen(input) {
      const proposal = await prisma.conversationSkillProposal.findFirst({
        where: { id: input.proposalId, tenantId: input.tenantId, status: 'open' },
      })
      if (!proposal) return { ok: false }
      await prisma.conversationSkillProposal.update({
        where: { id: proposal.id },
        data: { status: 'rejected', decidedById: input.adminId, decidedAt: new Date() },
      })
      return { ok: true, agentId: proposal.agentId }
    },
    async audit(input) {
      await writeAudit(repositories.audit, {
        actorType: 'human',
        actorId: input.actorId,
        action: input.action,
        targetType: 'skill',
        targetId: input.targetId,
        inputRef: input.agentId,
        metadata: { userId: input.actorId, agentId: input.agentId },
        tenantId: input.tenantId,
      })
    },
  }
}

export async function findProducerSkillId(tenantId: string): Promise<string | null> {
  const row = await prisma.skill.findFirst({
    where: { tenantId, producesSkills: true },
    select: { id: true },
  })
  return row?.id ?? null
}

export async function setProducesSkills(skillId: string, producesSkills: boolean): Promise<void> {
  await prisma.skill.update({ where: { id: skillId }, data: { producesSkills } })
}

export type OpenConversationSkillListRow = {
  id: string
  name: string
  description: string
  instructions: string
  attachments: Array<{ path: string; text: string }>
  agentId: string
  agentName: string
  requestedByName: string
  updatedAt: string
}

export async function listOpenConversationSkillProposals(
  tenantId: string,
): Promise<OpenConversationSkillListRow[]> {
  const rows = await prisma.conversationSkillProposal.findMany({
    where: { tenantId, status: 'open' },
    orderBy: { updatedAt: 'desc' },
    include: {
      agent: { select: { name: true } },
      requestedBy: { select: { name: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: parseSkillContent(row.content).instructions.join('\n\n'),
    attachments: parseSkillAttachments(row.attachments).map((attachment) => ({
      path: attachment.path,
      text: attachment.text,
    })),
    agentId: row.agentId,
    agentName: row.agent.name,
    requestedByName: row.requestedBy.name,
    updatedAt: row.updatedAt.toISOString(),
  }))
}
