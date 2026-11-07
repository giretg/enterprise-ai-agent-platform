'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { aiInteractionStore } from '@/auth/ai-audit-deps'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { listVoiceTranscripts, openVoiceTranscript } from '@/domain/ai-audit/ai-audit-service'
import { services } from '@/domain/gateway-services'
import { parseVoiceConfig, readVoiceConfig } from '@/domain/voice/config'
import { prisma } from '@/lib/db'
import { loadElevenLabsTenantKey } from '@/lib/elevenlabs-tenant-key'
import { FeatureNotEnabledError } from '@/domain/feature-flags/gates'
import { requireFeature } from '@/lib/feature-flags'
import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { fail, ok } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'

/** #1111: a hang-beszélgetés megkerüli a Model Gateway-t, ezért a pilotban csak superadmin kapcsolhatja be. */
export async function saveAgentVoiceConfigAction(input: { agentId: string; enabled: boolean; provider: string; voice: string; elevenLabsVoiceId: string; greeting: string; callStyle: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    if (!isSuperadmin(ctx.platformRoles)) return fail('A hang-beszélgetést csak platform-adminisztrátor állíthatja.')
    const agentId = z.string().uuid().parse(input.agentId)
    const parsed = parseVoiceConfig({
      enabled: input.enabled,
      provider: input.provider,
      voice: input.voice,
      elevenLabsVoiceId: input.elevenLabsVoiceId.trim() || undefined,
      greeting: input.greeting,
      callStyle: input.callStyle,
    })
    if (parsed.provider === 'elevenlabs') await requireFeature('voice.elevenlabs', { tenantId: ctx.activeTenantId })
    const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId: ctx.activeTenantId }, select: { kind: true, voiceConfig: true } })
    if (!agent) return fail('A munkatárs nem található.')
    if (agent.kind !== 'internal') return fail('Nyilvános asszisztensnél a hang-beszélgetés nem kapcsolható be.')
    const loadKey = parsed.provider === 'elevenlabs' ? loadElevenLabsTenantKey : loadOpenAiTenantKey
    if (parsed.enabled && !(await loadKey(ctx.activeTenantId))) {
      return fail(`A bekapcsoláshoz előbb add meg a céges ${parsed.provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}-kulcsot: Beállítások → Céges modellkulcsok.`)
    }
    // A szolgáltatónál létrehozott elemek azonosítója nem az űrlapról jön, de a mentés nem veszítheti el.
    const previous = agent.voiceConfig === null ? undefined : readVoiceConfig(agent.voiceConfig).elevenLabs
    const config = previous ? { ...parsed, elevenLabs: previous } : parsed
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
      metadata: { enabled: config.enabled, provider: config.provider, voice: config.voice, hasGreeting: config.greeting.length > 0, callStyle: config.callStyle },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${agentId}`)
    return ok({ enabled: config.enabled })
  } catch (e) {
    if (e instanceof z.ZodError) return fail('Az első mondat legfeljebb 300 karakter lehet, a hang-azonosító csak betűt és számot tartalmazhat, és a felkínált lehetőségek közül kell választani.')
    if (e instanceof TenantAuthError && e.code === 'INSUFFICIENT_ROLE') return fail('Ehhez ebben a szervezetben adminisztrátori szerep kell.')
    if (e instanceof FeatureNotEnabledError) return fail('Ennél a szervezetnél az ElevenLabs nincs bekapcsolva.')
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
