import type { SkillRiskTier, UserRole } from '@prisma/client'
import { z } from 'zod'
import {
  SKILL_ATTACHMENT_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_COUNT,
  SKILL_ATTACHMENTS_TOTAL_MAX_BYTES,
  hashAttachmentBytes,
  type SkillAttachment,
} from '@/lib/skill/skill-attachments'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  skillRequiresSchema,
  type SkillContent,
  type SkillRequirement,
} from '@/lib/skill/skill-content'
import { findInjectionPatterns, validateSkill } from '@/lib/skill/skill-validator'

/**
 * Beszélgetésből születő skill. A platform nem desztillál: a szöveget a modell
 * írja, ez a függvény kapuz és tárol. A chat és a ticket ugyanazt hívja.
 * A gyártó jelölő szándékosan nincs a bemeneten — ezt az utat nem lehet vele
 * gyártó skillt létrehozni.
 */

export const CONVERSATION_SKILL_AUDIT = {
  created: 'skill.conversation.created',
  proposed: 'skill.conversation.proposed',
  overwritten: 'skill.conversation.proposal.overwritten',
  approved: 'skill.conversation.approved',
  rejected: 'skill.conversation.rejected',
} as const

/** A beszélgetésből jövő skill mindig közönséges tenant skill. */
export function conversationSkillRecord(): {
  producesSkills: false
  kind: 'tenant'
  catalogScope: 'tenant'
} {
  return { producesSkills: false, kind: 'tenant', catalogScope: 'tenant' }
}

export function producerSkillMarkerError(input: {
  requested: boolean
  kind: 'tenant' | 'published' | 'system'
  existingProducerSkillId: string | null
  skillId?: string | null
}): string | null {
  if (!input.requested) return null
  if (input.kind !== 'tenant') return 'Gyártó skill csak tenant-skill lehet.'
  if (
    input.existingProducerSkillId &&
    input.existingProducerSkillId !== (input.skillId ?? null)
  ) {
    return 'Ebben a tenantban már van gyártó skill. Második létrehozását a platform elutasítja.'
  }
  return null
}

const attachmentInputSchema = z.object({
  path: z.string().min(1).max(300),
  text: z.string(),
})

export const conversationSkillSubmitSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  instructions: z.string().min(1).max(SKILL_INSTRUCTIONS_MAX),
  requires: skillRequiresSchema.optional(),
  attachments: z.array(attachmentInputSchema).max(SKILL_ATTACHMENT_MAX_COUNT).optional(),
})

export type ConversationSkillDraft = {
  name: string
  description: string
  content: SkillContent
  requires: SkillRequirement[]
  attachments: SkillAttachment[]
  riskTier: SkillRiskTier
}

export type ConversationSkillCaller = {
  userId: string
  tenantId: string
  role: UserRole
  assumed: boolean
}

export type OpenConversationSkillProposal = {
  id: string
  tenantId: string
  agentId: string
  requestedById: string
  name: string
  description: string
  content: SkillContent
  requires: SkillRequirement[]
  attachments: SkillAttachment[]
}

export type ConversationSkillPorts = {
  agentUsable: (input: ConversationSkillCaller & { agentId: string }) => Promise<boolean>
  producerEnabled: (input: { tenantId: string; agentId: string }) => Promise<boolean>
  allowedToolNames: (agentId: string) => Promise<string[]>
  openProposalId: (input: {
    tenantId: string
    userId: string
    agentId: string
  }) => Promise<string | null>
  nameTaken: (input: {
    tenantId: string
    name: string
    exceptProposalId?: string
  }) => Promise<boolean>
  createLive: (input: {
    tenantId: string
    userId: string
    agentId: string
    draft: ConversationSkillDraft
  }) => Promise<{ ok: true; skillId: string } | { ok: false; reason: 'name_taken' }>
  upsertOpen: (input: {
    tenantId: string
    userId: string
    agentId: string
    draft: ConversationSkillDraft
  }) => Promise<
    | { ok: true; proposalId: string; overwritten: boolean }
    | { ok: false; reason: 'name_taken' }
  >
  getOpen: (input: {
    tenantId: string
    proposalId: string
  }) => Promise<OpenConversationSkillProposal | null>
  updateOpen: (input: {
    tenantId: string
    proposalId: string
    name: string
    description: string
    content: SkillContent
  }) => Promise<boolean>
  commitApproval: (input: {
    tenantId: string
    proposalId: string
    adminId: string
    draft: ConversationSkillDraft
  }) => Promise<
    | { ok: true; skillId: string; agentId: string }
    | { ok: false; reason: 'name_taken' | 'not_open' }
  >
  rejectOpen: (input: {
    tenantId: string
    proposalId: string
    adminId: string
  }) => Promise<{ ok: true; agentId: string } | { ok: false }>
  audit: (input: {
    action: string
    actorId: string
    agentId: string
    targetId: string
    tenantId: string
  }) => Promise<void>
}

export type ConversationSkillOutcome =
  | {
      outcome: 'created'
      skillId: string
      assigned: true
      enabled: true
      missingTools: string[]
      message: string
    }
  | {
      outcome: 'pending_approval'
      proposalId: string
      missingTools: string[]
      message: string
    }
  | {
      outcome: 'rejected'
      reason: 'no_producer_skill' | 'cannot_use_agent' | 'validation' | 'name_taken'
      message: string
    }

function missingToolNames(requires: SkillRequirement[], allowed: readonly string[]): string[] {
  const granted = new Set(allowed)
  return [...new Set(requires.map((req) => req.toolName).filter((name) => !granted.has(name)))]
}

function withMissingTools(base: string, missing: string[]): string {
  if (missing.length === 0) return base
  return (
    `${base} Hiányzó eszközök: ${missing.join(', ')}. ` +
    'Eszközjogot a hívás nem adott — azt az admin az agent adatlapján adja meg.'
  )
}

function materializeAttachments(
  input: Array<{ path: string; text: string }>,
): SkillAttachment[] {
  const seen = new Set<string>()
  let total = 0
  return input.map((raw) => {
    const path = raw.path.trim().replace(/^\/+/, '')
    if (!path) throw new Error('A melléklet útvonala nem lehet üres.')
    if (path.split('/').includes('..')) throw new Error(`Nem megengedett melléklet-útvonal: ${raw.path}`)
    if (seen.has(path)) throw new Error(`Ismétlődő melléklet-útvonal: ${path}`)
    seen.add(path)
    const buf = Buffer.from(raw.text, 'utf8')
    if (buf.byteLength > SKILL_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `A(z) „${path}” melléklet túl nagy (max ${Math.floor(SKILL_ATTACHMENT_MAX_BYTES / 1024)} KB).`,
      )
    }
    total += buf.byteLength
    if (total > SKILL_ATTACHMENTS_TOTAL_MAX_BYTES) {
      throw new Error(
        `A mellékletek együtt túllépik a ${Math.floor(SKILL_ATTACHMENTS_TOTAL_MAX_BYTES / 1024)} KB-os keretet.`,
      )
    }
    return { path, text: raw.text, bytes: buf.byteLength, sha256: hashAttachmentBytes(buf) }
  })
}

export function prepareConversationSkillDraft(input: {
  name: string
  description: string
  instructions: string
  requires: SkillRequirement[]
  attachments: Array<{ path: string; text: string }>
}): { ok: true; draft: ConversationSkillDraft } | { ok: false; errors: string[] } {
  const instructions = input.instructions.trim()
  const content: SkillContent = {
    instructions: instructions ? [instructions] : [],
    triggerKeywords: [],
    parameters: [],
  }
  let attachments: SkillAttachment[]
  try {
    attachments = materializeAttachments(input.attachments)
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : 'Hibás melléklet.'] }
  }
  const validation = validateSkill({
    name: input.name,
    description: input.description,
    content,
    requires: input.requires,
    attachmentPaths: attachments.map((attachment) => attachment.path),
  })
  const attachmentInjection = attachments.flatMap((attachment) =>
    findInjectionPatterns(attachment.text).map(
      (label) => `Prompt-injection gyanús minta a mellékletben (${attachment.path}): ${label}.`,
    ),
  )
  const errors = [...validation.errors, ...attachmentInjection]
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    draft: {
      name: input.name.trim(),
      description: input.description.trim(),
      content,
      requires: input.requires,
      attachments,
      riskTier: validation.riskTier,
    },
  }
}

export async function submitConversationSkill(
  input: ConversationSkillCaller & {
    agentId: string
    name: string
    description: string
    instructions: string
    requires?: SkillRequirement[]
    attachments?: Array<{ path: string; text: string }>
  },
  ports: ConversationSkillPorts,
): Promise<ConversationSkillOutcome> {
  const usable = await ports.agentUsable(input)
  if (!usable) {
    return {
      outcome: 'rejected',
      reason: 'cannot_use_agent',
      message: 'Elutasítva: ezt az agentet nem használhatod. A skill nem került sorba.',
    }
  }
  const producerOn = await ports.producerEnabled({
    tenantId: input.tenantId,
    agentId: input.agentId,
  })
  if (!producerOn) {
    return {
      outcome: 'rejected',
      reason: 'no_producer_skill',
      message: 'Elutasítva: ezen az agenten nincs bekapcsolt gyártó skill. A skill nem került sorba.',
    }
  }
  const prepared = prepareConversationSkillDraft({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    requires: input.requires ?? [],
    attachments: input.attachments ?? [],
  })
  if (!prepared.ok) {
    return {
      outcome: 'rejected',
      reason: 'validation',
      message: `Elutasítva: ${prepared.errors.join(' · ')} Semmi nem került tárolásra.`,
    }
  }

  const exceptProposalId =
    input.role === 'admin'
      ? undefined
      : (await ports.openProposalId({
          tenantId: input.tenantId,
          userId: input.userId,
          agentId: input.agentId,
        })) ?? undefined
  const taken = await ports.nameTaken({
    tenantId: input.tenantId,
    name: prepared.draft.name,
    exceptProposalId,
  })
  if (taken) {
    return {
      outcome: 'rejected',
      reason: 'name_taken',
      message:
        'Elutasítva: ez a név foglalt (aktív skill vagy nyitott javaslat). Semmi nem került tárolásra. Hívj újra másik névvel.',
    }
  }

  const missingTools = missingToolNames(
    prepared.draft.requires,
    await ports.allowedToolNames(input.agentId),
  )
  const live = input.role === 'admin'
  if (live) {
    const created = await ports.createLive({
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      draft: prepared.draft,
    })
    if (!created.ok) {
      return {
        outcome: 'rejected',
        reason: 'name_taken',
        message:
          'Elutasítva: ez a név foglalt (aktív skill vagy nyitott javaslat). Semmi nem került tárolásra. Hívj újra másik névvel.',
      }
    }
    await ports.audit({
      action: CONVERSATION_SKILL_AUDIT.created,
      actorId: input.userId,
      agentId: input.agentId,
      targetId: created.skillId,
      tenantId: input.tenantId,
    })
    return {
      outcome: 'created',
      skillId: created.skillId,
      assigned: true,
      enabled: true,
      missingTools,
      message: withMissingTools(
        `A skill létrejött és él (${created.skillId}). Hozzá van rendelve ehhez az agenthez, és be van kapcsolva.`,
        missingTools,
      ),
    }
  }

  const queued = await ports.upsertOpen({
    tenantId: input.tenantId,
    userId: input.userId,
    agentId: input.agentId,
    draft: prepared.draft,
  })
  if (!queued.ok) {
    return {
      outcome: 'rejected',
      reason: 'name_taken',
      message:
        'Elutasítva: ez a név foglalt (aktív skill vagy nyitott javaslat). Semmi nem került tárolásra. Hívj újra másik névvel.',
    }
  }
  await ports.audit({
    action: queued.overwritten
      ? CONVERSATION_SKILL_AUDIT.overwritten
      : CONVERSATION_SKILL_AUDIT.proposed,
    actorId: input.userId,
    agentId: input.agentId,
    targetId: queued.proposalId,
    tenantId: input.tenantId,
  })
  const pendingBase = queued.overwritten
    ? 'A skill jóváhagyásra vár. A korábbi nyitott javaslatod ehhez az agenthez felülíródott, a régi név felszabadult.'
    : 'A skill jóváhagyásra vár. Tenant admin a képességek katalógusában bírálja.'
  return {
    outcome: 'pending_approval',
    proposalId: queued.proposalId,
    missingTools,
    message: withMissingTools(pendingBase, missingTools),
  }
}

const ADMIN_ONLY = 'Csak tenant admin bírálhat skill-javaslatot.'

export async function reviseConversationSkillProposal(
  input: {
    actorRole: UserRole
    tenantId: string
    proposalId: string
    name: string
    description: string
    instructions: string
  },
  ports: ConversationSkillPorts,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.actorRole !== 'admin') return { ok: false, message: ADMIN_ONLY }
  const open = await ports.getOpen({ tenantId: input.tenantId, proposalId: input.proposalId })
  if (!open) return { ok: false, message: 'Nincs ilyen nyitott javaslat.' }
  const prepared = prepareConversationSkillDraft({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    requires: open.requires,
    attachments: open.attachments.map((attachment) => ({
      path: attachment.path,
      text: attachment.text,
    })),
  })
  if (!prepared.ok) return { ok: false, message: prepared.errors.join(' · ') }
  const taken = await ports.nameTaken({
    tenantId: input.tenantId,
    name: prepared.draft.name,
    exceptProposalId: open.id,
  })
  if (taken) {
    return {
      ok: false,
      message: 'Ez a név foglalt (aktív skill vagy másik nyitott javaslat).',
    }
  }
  const saved = await ports.updateOpen({
    tenantId: input.tenantId,
    proposalId: open.id,
    name: prepared.draft.name,
    description: prepared.draft.description,
    content: { ...open.content, instructions: prepared.draft.content.instructions },
  })
  if (!saved) return { ok: false, message: 'Nincs ilyen nyitott javaslat.' }
  return { ok: true }
}

export async function decideConversationSkillProposal(
  input: {
    actorRole: UserRole
    tenantId: string
    adminId: string
    proposalId: string
    decision: 'approve' | 'reject'
  },
  ports: ConversationSkillPorts,
): Promise<{ ok: true; skillId?: string; missingTools?: string[] } | { ok: false; message: string }> {
  if (input.actorRole !== 'admin') return { ok: false, message: ADMIN_ONLY }
  const open = await ports.getOpen({ tenantId: input.tenantId, proposalId: input.proposalId })
  if (!open) return { ok: false, message: 'Nincs ilyen nyitott javaslat.' }

  if (input.decision === 'reject') {
    const rejected = await ports.rejectOpen({
      tenantId: input.tenantId,
      proposalId: open.id,
      adminId: input.adminId,
    })
    if (!rejected.ok) return { ok: false, message: 'Nincs ilyen nyitott javaslat.' }
    await ports.audit({
      action: CONVERSATION_SKILL_AUDIT.rejected,
      actorId: input.adminId,
      agentId: rejected.agentId,
      targetId: open.id,
      tenantId: input.tenantId,
    })
    return { ok: true }
  }

  const prepared = prepareConversationSkillDraft({
    name: open.name,
    description: open.description,
    instructions: open.content.instructions.join('\n\n'),
    requires: open.requires,
    attachments: open.attachments.map((attachment) => ({
      path: attachment.path,
      text: attachment.text,
    })),
  })
  if (!prepared.ok) return { ok: false, message: prepared.errors.join(' · ') }
  const taken = await ports.nameTaken({
    tenantId: input.tenantId,
    name: prepared.draft.name,
    exceptProposalId: open.id,
  })
  if (taken) {
    return {
      ok: false,
      message: 'Ez a név foglalt (aktív skill vagy másik nyitott javaslat). Írd át a nevet, aztán hagyd jóvá.',
    }
  }
  const approved = await ports.commitApproval({
    tenantId: input.tenantId,
    proposalId: open.id,
    adminId: input.adminId,
    draft: prepared.draft,
  })
  if (!approved.ok) {
    return {
      ok: false,
      message:
        approved.reason === 'name_taken'
          ? 'Ez a név foglalt (aktív skill vagy másik nyitott javaslat). Írd át a nevet, aztán hagyd jóvá.'
          : 'Nincs ilyen nyitott javaslat.',
    }
  }
  await ports.audit({
    action: CONVERSATION_SKILL_AUDIT.approved,
    actorId: input.adminId,
    agentId: approved.agentId,
    targetId: approved.skillId,
    tenantId: input.tenantId,
  })
  const missingTools = missingToolNames(
    prepared.draft.requires,
    await ports.allowedToolNames(approved.agentId),
  )
  return { ok: true, skillId: approved.skillId, missingTools }
}
