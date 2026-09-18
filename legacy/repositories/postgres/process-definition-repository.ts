import type { ProcessDefinition, ProcessTrigger, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  CreateProcessDefinitionInput,
  CreateProcessTriggerInput,
  ProcessDefinitionRepository,
  ProcessDefinitionWithTriggers,
} from '../interfaces'

/**
 * PostgresProcessDefinitionRepository (Folyamat-feature-spec §1, §4.1, §7).
 *
 * A Folyamat (2. szint) perzisztencia-rétege: `process_definitions` +
 * `process_triggers`. Minden lekérdezés `(tenant_id, id)` párral scope-olt (a hívó
 * ProcessDefinitionService a NOT_FOUND/FORBIDDEN esetet nem különbözteti meg).
 */
export class PostgresProcessDefinitionRepository implements ProcessDefinitionRepository {
  async create(input: CreateProcessDefinitionInput): Promise<ProcessDefinition> {
    return prisma.processDefinition.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
        playbookId: input.playbookId,
        playbookVersionId: input.playbookVersionId,
        createdById: input.createdById,
      },
    })
  }

  async findById(
    tenantId: string | null,
    id: string,
  ): Promise<ProcessDefinitionWithTriggers | null> {
    return prisma.processDefinition.findFirst({
      where: { id, tenantId },
      include: { triggers: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } } },
    })
  }

  async list(
    tenantId: string | null,
    status?: ProcessDefinition['status'],
  ): Promise<ProcessDefinitionWithTriggers[]> {
    return prisma.processDefinition.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      include: { triggers: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async update(
    id: string,
    data: Partial<{
      name: string
      description: string | null
      status: ProcessDefinition['status']
      playbookId: string
      playbookVersionId: string
      roleBindings: Prisma.InputJsonValue
      configValues: Prisma.InputJsonValue
      approvedById: string | null
      approvedAt: Date | null
      archivedAt: Date | null
    }>,
  ): Promise<ProcessDefinition> {
    return prisma.processDefinition.update({ where: { id }, data })
  }

  async createTrigger(input: CreateProcessTriggerInput): Promise<ProcessTrigger> {
    return prisma.processTrigger.create({
      data: {
        tenantId: input.tenantId,
        processDefinitionId: input.processDefinitionId,
        type: input.type,
        inputMap: input.inputMap,
        monitorDefinitionId: input.monitorDefinitionId ?? null,
        createdById: input.createdById,
      },
    })
  }

  async findTrigger(tenantId: string | null, id: string): Promise<ProcessTrigger | null> {
    return prisma.processTrigger.findFirst({ where: { id, tenantId, revokedAt: null } })
  }

  async listTriggers(processDefinitionId: string): Promise<ProcessTrigger[]> {
    return prisma.processTrigger.findMany({
      where: { processDefinitionId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    })
  }

  async listActiveMonitorCronTriggers(
    tenantId: string | null,
    monitorDefinitionId: string,
  ): Promise<ProcessTrigger[]> {
    return prisma.processTrigger.findMany({
      where: {
        tenantId,
        type: 'monitor_cron',
        enabled: true,
        revokedAt: null,
        monitorDefinitionId,
        processDefinition: { status: 'active' },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async deleteTrigger(id: string): Promise<void> {
    await prisma.processTrigger.delete({ where: { id } })
  }
}
