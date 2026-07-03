import { requireRole } from '@/auth'
import { services } from '@/domain'
import { apiError, apiOk, readJson } from '@/lib/api-response'
import {
  createProcessDefinitionSchema,
  listProcessDefinitionsSchema,
} from '@/lib/validators/actions'
import { ProcessDefinitionServiceError } from '@/domain/playbook/process-definition-service'

type AuthedUser = Awaited<ReturnType<typeof requireRole>>

function tenantOf(user: AuthedUser): string {
  return user.tenantId ?? user.id
}

function serializeDefinition(def: Awaited<ReturnType<typeof services.processDefinitions.getDefinition>>) {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    status: def.status,
    playbookId: def.playbookId,
    playbookVersionId: def.playbookVersionId,
    roleBindings: def.roleBindings,
    configValues: def.configValues,
    approvedAt: def.approvedAt?.toISOString() ?? null,
    updatedAt: def.updatedAt.toISOString(),
    triggers: def.triggers.map((t) => ({
      id: t.id,
      type: t.type,
      enabled: t.enabled,
      inputMap: t.inputMap,
      monitorDefinitionId: t.monitorDefinitionId,
      createdAt: t.createdAt.toISOString(),
    })),
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireRole('viewer')
    const url = new URL(request.url)
    const parsed = listProcessDefinitionsSchema.safeParse({
      status: url.searchParams.get('status') ?? undefined,
    })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const defs = await services.processDefinitions.listDefinitions(tenantOf(user), parsed.data.status)
    return apiOk(defs.map(serializeDefinition))
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Nem sikerült betölteni a Folyamatokat', 500)
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRole('operator')
    const parsed = createProcessDefinitionSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const def = await services.processDefinitions.createDraft({
      tenantId: tenantOf(user),
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      playbookVersionId: parsed.data.playbookVersionId,
      createdBy: { userId: user.id },
    })
    return apiOk({ id: def.id }, 201)
  } catch (e) {
    if (e instanceof ProcessDefinitionServiceError) return apiError(e.message, 400, e.details)
    return apiError(e instanceof Error ? e.message : 'Nem sikerült létrehozni a Folyamat-draftot', 500)
  }
}
