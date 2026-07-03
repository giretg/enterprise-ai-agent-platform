import { requireRole } from '@/auth'
import { services } from '@/domain'
import { apiError, apiOk } from '@/lib/api-response'
import { detachProcessTriggerSchema } from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

type AuthedUser = Awaited<ReturnType<typeof requireRole>>

function tenantOf(user: AuthedUser): string {
  return user.tenantId ?? user.id
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; tid: string }> },
) {
  try {
    const user = await requireRole('operator')
    const { id, tid } = await params
    const parsed = detachProcessTriggerSchema.safeParse({ processDefinitionId: id, triggerId: tid })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    await services.processDefinitions.detachTrigger({
      tenantId: tenantOf(user),
      processDefinitionId: parsed.data.processDefinitionId,
      triggerId: parsed.data.triggerId,
      actorUserId: user.id,
    })
    return apiOk({ id: parsed.data.triggerId })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült leválasztani a triggert', 500)
  }
}
