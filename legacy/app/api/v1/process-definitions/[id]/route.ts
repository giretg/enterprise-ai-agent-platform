import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { apiError, apiOk, readJson } from '@/lib/api-response'
import { updateProcessDefinitionBindingsSchema } from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireTenantRole('operator')
    const { id } = await params
    const parsed = updateProcessDefinitionBindingsSchema.safeParse({
      ...(await readJson(request) as Record<string, unknown>),
      id,
    })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const def = await services.processDefinitions.updateBindings({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.data.id,
      roleBindings: parsed.data.roleBindings,
      configValues: parsed.data.configValues ?? {},
      actorUserId: user.user.id,
    })
    return apiOk({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült frissíteni a Folyamat kötéseit', 500)
  }
}
