'use server'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { codeSandboxConfigSchema } from '@/domain/code-sandbox/code-sandbox-types'
import { createSandboxProvider } from '@/domain/code-sandbox/http-sandbox-provider'
import {
  buildConnectorSecretRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'
import { prisma } from '@/lib/db'
import { withConnectorPrivacySlot } from '@/lib/privacy-slot'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

const inputSchema = z.object({
  connectorId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  provider: z.enum(['cloud_run', 'e2b_compatible']),
  region: z.string().trim().min(1).max(64),
  baseUrl: z.string().url(),
  maxExecSec: z.number().int().min(1).max(900),
  cpuProfile: z.string().trim().min(1).max(64).default('1'),
  memoryProfile: z.string().trim().min(1).max(64).default('512Mi'),
  apiKey: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
})

export async function listCodeSandboxConnectors() {
  try {
    const auth = await requireTenantRole('admin')
    const connectors = await prisma.connector.findMany({
      where: { tenantId: auth.activeTenantId!, type: 'code_sandbox' },
      orderBy: { name: 'asc' },
      include: {
        toolCalls: {
          where: { toolName: 'sandbox_exec' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            status: true,
            latencyMs: true,
            resultMeta: true,
            createdAt: true,
          },
        },
      },
    })
    return ok(
      connectors.map((connector) => ({
        id: connector.id,
        name: connector.name,
        lifecycleState: connector.lifecycleState,
        hasApiKey: Boolean(connector.secretAlias),
        config: codeSandboxConfigSchema.parse(connector.config),
        lastCall: connector.toolCalls[0]
          ? {
              status: connector.toolCalls[0].status,
              latencyMs: connector.toolCalls[0].latencyMs,
              metrics: connector.toolCalls[0].resultMeta as Record<
                string,
                unknown
              > | null,
              createdAt: connector.toolCalls[0].createdAt.toISOString(),
            }
          : null,
      })),
    )
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : 'A kódfuttató connectorok betöltése sikertelen.',
    )
  }
}

export async function saveCodeSandboxConnector(input: unknown) {
  try {
    const auth = await requireTenantRole('admin')
    const parsed = inputSchema.parse(input)
    const tenantId = auth.activeTenantId!
    const config = codeSandboxConfigSchema.parse({
      provider: parsed.provider,
      region: parsed.region,
      baseUrl: parsed.baseUrl,
      maxExecSec: parsed.maxExecSec,
      defaultAllowEgress: false,
      cpuProfile: parsed.cpuProfile,
      memoryProfile: parsed.memoryProfile,
    })
    const existing = parsed.connectorId
      ? await prisma.connector.findFirst({
          where: { id: parsed.connectorId, tenantId, type: 'code_sandbox' },
        })
      : null
    if (parsed.connectorId && !existing)
      return fail('A kódfuttató connector nem található.')

    const connector = existing
      ? await prisma.connector.update({
          where: { id: existing.id },
          data: {
            name: parsed.name,
            config: config as unknown as Prisma.InputJsonValue,
            lifecycleState: parsed.enabled ? 'active' : 'blocked',
            version: { increment: 1 },
          },
        })
      : await prisma.connector.create({
          data: await withConnectorPrivacySlot(prisma, {
            type: 'code_sandbox',
            name: parsed.name,
            authMode: 'service',
            scope: 'global',
            tenantId,
            config: config as unknown as Prisma.InputJsonValue,
            lifecycleState: parsed.enabled ? 'active' : 'blocked',
          }),
        })

    if (parsed.apiKey?.trim()) {
      await saveConnectorApiKey(connector.id, parsed.apiKey.trim())
      await prisma.connector.update({
        where: { id: connector.id },
        data: { secretAlias: buildConnectorSecretRef(connector.id) },
      })
    }
    await repositories.audit.append({
      actorType: 'human',
      actorId: auth.user.id,
      agentVersion: null,
      action: existing ? 'connector.update' : 'connector.create',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: parsed.name,
      outputRef: parsed.enabled ? 'active' : 'blocked',
      policyDecision: 'allowed',
      tenantId,
      metadata: {
        provider: config.provider,
        region: config.region,
        apiKeyRotated: Boolean(parsed.apiKey),
      } as Prisma.JsonValue,
    })
    return ok({ connectorId: connector.id })
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : 'A kódfuttató connector mentése sikertelen.',
    )
  }
}

export async function testCodeSandboxConnector(input: { connectorId: string }) {
  try {
    const auth = await requireTenantRole('admin')
    const connector = await prisma.connector.findFirst({
      where: {
        id: z.string().uuid().parse(input.connectorId),
        tenantId: auth.activeTenantId!,
        type: 'code_sandbox',
      },
    })
    if (!connector) return fail('A kódfuttató connector nem található.')
    const provider = createSandboxProvider(
      codeSandboxConfigSchema.parse(connector.config),
      connector.secretAlias,
    )
    const status = await provider.checkHealth()
    return status === 'ready'
      ? ok({ status })
      : fail('A próba sandbox-életciklus nem futott le.')
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : 'A kapcsolat tesztelése sikertelen.',
    )
  }
}
