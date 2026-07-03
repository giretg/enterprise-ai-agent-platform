import { requireRole } from '@/auth'
import { services } from '@/domain'
import { apiError, apiOk } from '@/lib/api-response'
import { processDefinitionIdSchema } from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

type AuthedUser = Awaited<ReturnType<typeof requireRole>>

function tenantOf(user: AuthedUser): string {
  return user.tenantId ?? user.id
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole('admin')
    const parsed = processDefinitionIdSchema.safeParse(await params)
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const def = await services.processDefinitions.archive({
      tenantId: tenantOf(user),
      processDefinitionId: parsed.data.id,
      actorUserId: user.id,
    })
    return apiOk({ id: def.id, status: def.status })
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült archiválni a Folyamatot', 500)
  }
}
