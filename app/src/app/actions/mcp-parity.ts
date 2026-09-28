'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { getMcpParityReport } from '@/domain/mcp-parity/mcp-parity-service'
import { fail, ok } from '@/lib/result'

const schema = z.object({
  days: z.number().int().min(1).max(90).optional(),
})

/** MCP-paritás admin riport (#666): agent×kliens arányok + napi trend. */
export async function getMcpParityReportAction(input?: z.infer<typeof schema>) {
  try {
    const user = await requireTenantRole('approver')
    if (!user.activeTenantId) return fail('Nincs kiválasztott szervezet.')
    const parsed = input ? schema.parse(input) : {}
    const since = new Date(Date.now() - (parsed.days ?? 30) * 24 * 60 * 60 * 1000)
    const report = await getMcpParityReport(services.audit, {
      tenantId: user.activeTenantId,
      since,
    })
    return ok(JSON.parse(JSON.stringify(report)))
  } catch {
    return fail('A paritás-jelentés nem tölthető be.')
  }
}
