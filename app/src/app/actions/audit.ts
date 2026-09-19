'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { fail, ok } from '@/lib/result'

const listAuditLogSchema = z.object({
  action: z.string().min(1).max(120).optional(),
  actorType: z.enum(['human', 'agent', 'system']).optional(),
  actorId: z.string().uuid().optional(),
  targetType: z.string().min(1).max(120).optional(),
  targetId: z.string().uuid().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export async function listAuditLog(input?: z.infer<typeof listAuditLogSchema>) {
  try {
    const user = await requireTenantRole('approver')
    if (!user.activeTenantId) return fail('Tenant required')
    const parsed = input ? listAuditLogSchema.parse(input) : {}
    const since = parsed.since ? new Date(parsed.since) : undefined
    const entries = await services.audit.findMany({
      tenantId: user.activeTenantId,
      limit: parsed.limit ?? 200,
      action: parsed.action,
      actorType: parsed.actorType,
      actorId: parsed.actorId,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
    })
    return ok(
      entries.map((entry) => ({
        ...entry,
        seq: entry.seq.toString(),
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list audit log')
  }
}

export async function verifyAuditChain() {
  try {
    const user = await requireTenantRole('approver')
    if (!user.activeTenantId) return fail('Tenant required')
    const result = await services.auditChain.verifyChain(undefined, undefined, user.activeTenantId)
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Verification failed')
  }
}

export async function exportAuditSiem(input?: { since?: string }) {
  try {
    const user = await requireTenantRole('approver')
    if (!user.activeTenantId) return fail('Tenant required')
    const { since } = z.object({ since: z.coerce.date().optional() }).parse(input ?? {})
    const jsonLines = await services.auditChain.exportJsonLines({
      tenantId: user.activeTenantId,
      since,
    })
    return ok({
      content: jsonLines,
      filename: `audit-siem-${new Date().toISOString().slice(0, 10)}.jsonl`,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Export failed')
  }
}
