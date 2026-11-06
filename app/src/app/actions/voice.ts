'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { parseVoiceConfig } from '@/domain/voice/config'
import { prisma } from '@/lib/db'
import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { fail, ok } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'

/** #1111: a hang-beszélgetés megkerüli a Model Gateway-t, ezért a pilotban csak superadmin kapcsolhatja be. */
export async function saveAgentVoiceConfigAction(input: { agentId: string; enabled: boolean; voice: string; greeting: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    if (!isSuperadmin(ctx.platformRoles)) return fail('A hang-beszélgetést csak platform-adminisztrátor állíthatja.')
    const agentId = z.string().uuid().parse(input.agentId)
    const config = parseVoiceConfig({ enabled: input.enabled, voice: input.voice, greeting: input.greeting })
    const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId: ctx.activeTenantId }, select: { kind: true } })
    if (!agent) return fail('A munkatárs nem található.')
    if (agent.kind !== 'internal') return fail('Nyilvános asszisztensnél a hang-beszélgetés nem kapcsolható be.')
    if (config.enabled && !(await loadOpenAiTenantKey(ctx.activeTenantId))) {
      return fail('A bekapcsoláshoz előbb add meg a céges OpenAI-kulcsot: Beállítások → Céges modellkulcsok.')
    }
    await prisma.agent.update({ where: { id: agentId }, data: { voiceConfig: config } })
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'agent.voice_settings',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: String(config.enabled),
      policyDecision: 'updated',
      metadata: { enabled: config.enabled, voice: config.voice, hasGreeting: config.greeting.length > 0 },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${agentId}`)
    return ok(config)
  } catch (e) {
    if (e instanceof z.ZodError) return fail('Az első mondat legfeljebb 300 karakter lehet, és létező hangot kell választani.')
    if (e instanceof TenantAuthError && e.code === 'INSUFFICIENT_ROLE') return fail('Ehhez ebben a szervezetben adminisztrátori szerep kell.')
    console.warn('[voice] saving the voice settings failed', e instanceof Error ? e.name : 'unknown')
    return fail('A mentés nem sikerült. Frissítsd az oldalt, és próbáld újra.')
  }
}
