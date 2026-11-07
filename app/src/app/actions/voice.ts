'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { aiInteractionStore } from '@/auth/ai-audit-deps'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { listVoiceTranscripts, openVoiceTranscript } from '@/domain/ai-audit/ai-audit-service'
import { services } from '@/domain/gateway-services'
import { parseVoiceConfig } from '@/domain/voice/config'
import { prisma } from '@/lib/db'
import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { fail, ok } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'

/** #1111: a hang-beszélgetés megkerüli a Model Gateway-t, ezért a pilotban csak superadmin kapcsolhatja be. */
export async function saveAgentVoiceConfigAction(input: { agentId: string; enabled: boolean; voice: string; greeting: string; callStyle: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    if (!isSuperadmin(ctx.platformRoles)) return fail('A hang-beszélgetést csak platform-adminisztrátor állíthatja.')
    const agentId = z.string().uuid().parse(input.agentId)
    const config = parseVoiceConfig({ enabled: input.enabled, voice: input.voice, greeting: input.greeting, callStyle: input.callStyle })
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
      metadata: { enabled: config.enabled, voice: config.voice, hasGreeting: config.greeting.length > 0, callStyle: config.callStyle },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${agentId}`)
    return ok(config)
  } catch (e) {
    if (e instanceof z.ZodError) return fail('Az első mondat legfeljebb 300 karakter lehet, és a felkínált hangok és gombok közül kell választani.')
    if (e instanceof TenantAuthError && e.code === 'INSUFFICIENT_ROLE') return fail('Ehhez ebben a szervezetben adminisztrátori szerep kell.')
    console.warn('[voice] saving the voice settings failed', e instanceof Error ? e.name : 'unknown')
    return fail('A mentés nem sikerült. Frissítsd az oldalt, és próbáld újra.')
  }
}

export async function listVoiceTranscriptsAction(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const agentId = z.string().uuid().parse(input.agentId)
    return ok(await listVoiceTranscripts(aiInteractionStore, { tenantId: ctx.activeTenantId, agentId }))
  } catch (e) {
    if (e instanceof TenantAuthError && e.code === 'INSUFFICIENT_ROLE') return fail('Ehhez ebben a szervezetben adminisztrátori szerep kell.')
    console.warn('[voice] listing the transcripts failed', e instanceof Error ? e.name : 'unknown')
    return fail('A beszélgetések listáját nem sikerült betölteni. Frissítsd az oldalt, és próbáld újra.')
  }
}

/** Egy admin is megnyithatja, de minden megnyitásnak nyoma marad az auditban. */
export async function readVoiceTranscriptAction(input: { agentId: string; id: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const transcript = await openVoiceTranscript(
      { store: aiInteractionStore, audit: services.audit },
      {
        tenantId: ctx.activeTenantId,
        agentId: z.string().uuid().parse(input.agentId),
        id: z.string().uuid().parse(input.id),
        actorId: ctx.user.id,
        assumed: ctx.assumed,
      },
    )
    if (!transcript) return fail('Ehhez a beszélgetéshez nincs elmentett szöveg.')
    return ok(transcript)
  } catch (e) {
    if (e instanceof TenantAuthError && e.code === 'INSUFFICIENT_ROLE') return fail('Ehhez ebben a szervezetben adminisztrátori szerep kell.')
    console.warn('[voice] reading the transcript failed', e instanceof Error ? e.name : 'unknown')
    return fail('A beszélgetést nem sikerült megnyitni. Frissítsd az oldalt, és próbáld újra.')
  }
}
