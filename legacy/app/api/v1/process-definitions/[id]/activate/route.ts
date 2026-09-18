import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { apiError, apiOk } from '@/lib/api-response'
import { processDefinitionIdSchema } from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = processDefinitionIdSchema.safeParse(await params)
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const def = await services.processDefinitions.activate({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.data.id,
      actorUserId: user.user.id,
    })
    return apiOk({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült aktiválni a Folyamatot', 500)
  }
}
