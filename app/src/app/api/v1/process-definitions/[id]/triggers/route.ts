import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { apiError, apiOk, readJson } from '@/lib/api-response'
import { attachProcessTriggerSchema } from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireTenantRole('operator')
    const { id } = await params
    const parsed = attachProcessTriggerSchema.safeParse({
      ...(await readJson(request) as Record<string, unknown>),
      processDefinitionId: id,
    })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const trigger = await services.processDefinitions.attachTrigger({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.data.processDefinitionId,
      type: parsed.data.type,
      inputMap: parsed.data.inputMap ?? {},
      monitorDefinitionId: parsed.data.monitorDefinitionId ?? null,
      actorUserId: user.user.id,
    })
    return apiOk({ id: trigger.id }, 201)
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült csatolni a triggert', 500)
  }
}
