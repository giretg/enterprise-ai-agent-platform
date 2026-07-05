import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { apiError, apiOk, readJson } from '@/lib/api-response'
import { startProcessSchema } from '@/lib/validators/actions'
import { ProcessServiceError } from '@/domain/playbook/process-service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireTenantRole('operator')
    const { id } = await params
    const body = await readJson(request)
    const parsed = startProcessSchema.safeParse({
      ...(body as Record<string, unknown>),
      processDefinitionId: id,
    })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const process = await services.processes.startProcess({
      tenantId: user.activeTenantId,
      processDefinitionId: parsed.data.processDefinitionId,
      triggerType: parsed.data.triggerType ?? 'manual',
      inputPayload: parsed.data.inputPayload ?? {},
      startedBy: { type: 'user', id: user.user.id },
      conversationId: parsed.data.conversationId ?? null,
      rootTicketId: parsed.data.rootTicketId ?? null,
    })
    return apiOk({ id: process.id }, 201)
  } catch (e) {
    if (e instanceof ProcessServiceError) return apiError(e.message, 400)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült elindítani a Futást', 500)
  }
}
