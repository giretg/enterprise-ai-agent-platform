'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import {
  decideConversationSkillProposal,
  reviseConversationSkillProposal,
} from '@/domain/skill/conversation-skill'
import { fail, ok, type ActionResult } from '@/lib/result'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
} from '@/lib/skill/skill-content'
import {
  buildConversationSkillPorts,
  listOpenConversationSkillProposals,
  type OpenConversationSkillListRow,
} from '@/repositories/postgres/conversation-skill-repository'

function ports() {
  return buildConversationSkillPorts()
}

export async function listConversationSkillProposalsAction(): Promise<
  ActionResult<OpenConversationSkillListRow[]>
> {
  try {
    const ctx = await requireTenantRole('admin')
    if (!ctx.activeTenantId) return fail('Nincs aktív tenant.')
    return ok(await listOpenConversationSkillProposals(ctx.activeTenantId))
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'A javaslatok betöltése sikertelen.')
  }
}

const reviseSchema = z.object({
  proposalId: z.string().uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  instructions: z.string().min(1).max(SKILL_INSTRUCTIONS_MAX),
})

export async function reviseConversationSkillProposalAction(
  input: z.input<typeof reviseSchema>,
): Promise<ActionResult<null>> {
  try {
    const parsed = reviseSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    if (!ctx.activeTenantId || !ctx.activeTenantRole) return fail('Nincs aktív tenant.')
    const result = await reviseConversationSkillProposal(
      {
        actorRole: ctx.activeTenantRole,
        tenantId: ctx.activeTenantId,
        proposalId: parsed.proposalId,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
      },
      ports(),
    )
    if (!result.ok) return fail(result.message)
    revalidatePath('/control-plane/skills')
    return ok(null)
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'A javaslat mentése sikertelen.')
  }
}

export async function decideConversationSkillProposalAction(input: {
  proposalId: string
  decision: 'approve' | 'reject'
}): Promise<ActionResult<{ skillId?: string; missingTools?: string[] }>> {
  try {
    const proposalId = z.string().uuid().parse(input.proposalId)
    const decision = z.enum(['approve', 'reject']).parse(input.decision)
    const ctx = await requireTenantRole('admin')
    if (!ctx.activeTenantId || !ctx.activeTenantRole) return fail('Nincs aktív tenant.')
    const result = await decideConversationSkillProposal(
      {
        actorRole: ctx.activeTenantRole,
        tenantId: ctx.activeTenantId,
        adminId: ctx.user.id,
        proposalId,
        decision,
      },
      ports(),
    )
    if (!result.ok) return fail(result.message)
    revalidatePath('/control-plane/skills')
    return ok({ skillId: result.skillId, missingTools: result.missingTools })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'A bírálat sikertelen.')
  }
}
