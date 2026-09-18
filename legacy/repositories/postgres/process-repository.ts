import type {
  ProcessInstance,
  ProcessStepInstance,
  DelegationEdge,
  ProcessStatus,
  Prisma,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
import type {
  CreateProcessInstanceInput,
  CreateProcessStepInput,
  CreateDelegationEdgeInput,
  ProcessInstanceDetail,
  ProcessRepository,
} from '../interfaces'

/**
 * PostgresProcessRepository (Feature-spec — Playbook §4.5–4.7, §8.2).
 *
 * A Fázis 2 process runtime (process_instances / process_step_instances /
 * delegation_edges) perzisztencia-rétege. Minden lekérdezés `(tenant_id, id)`
 * párral scope-olt (§11.4), és a hívó `ProcessService` SOHA nem ad cross-tenant
 * eredményt — a NOT_FOUND és FORBIDDEN nem megkülönböztetett.
 */
export class PostgresProcessRepository implements ProcessRepository {
  async createProcess(input: CreateProcessInstanceInput): Promise<ProcessInstance> {
    return prisma.processInstance.create({
      data: {
        tenantId: input.tenantId,
        processType: input.processType,
        playbookId: input.playbookId,
        playbookVersionId: input.playbookVersionId,
        playbookRef: input.playbookRef,
        playbookContentHash: input.playbookContentHash,
        processDefinitionId: input.processDefinitionId ?? null,
        triggerType: input.triggerType ?? null,
        startedByType: input.startedByType,
        startedByUserId: input.startedByUserId ?? null,
        startedByAgentId: input.startedByAgentId ?? null,
        conversationId: input.conversationId ?? null,
        rootTicketId: input.rootTicketId ?? null,
        inputPayload: input.inputPayload,
      },
    })
  }

  async findProcess(tenantId: string | null, id: string): Promise<ProcessInstance | null> {
    return prisma.processInstance.findFirst({ where: { id, tenantId } })
  }

  async findProcessDetail(
    tenantId: string | null,
    id: string,
  ): Promise<ProcessInstanceDetail | null> {
    return prisma.processInstance.findFirst({
      where: { id, tenantId },
      include: {
        steps: { orderBy: { startedAt: 'asc' } },
        delegations: { orderBy: { createdAt: 'asc' } },
      },
    })
  }

  async listProcesses(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ): Promise<ProcessInstance[]> {
    const page = await this.listProcessesPage(
      tenantId,
      opts?.limit !== undefined || opts?.offset !== undefined || opts?.unbounded
        ? opts
        : { unbounded: true },
    )
    return page.items
  }

  async listProcessesPage(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ) {
    const { take, skip, pageLimit } = prismaPageArgs(opts)
    const offset = skip ?? 0
    const rows = await prisma.processInstance.findMany({
      where: { tenantId },
      orderBy: { startedAt: 'desc' },
      ...(take !== undefined ? { take, skip: offset } : {}),
    })
    return toListPage(rows, pageLimit, offset)
  }

  async updateProcess(
    id: string,
    data: Partial<{
      status: ProcessInstance['status']
      rootTicketId: string | null
      outputPayload: Prisma.InputJsonValue
      completedAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<ProcessInstance> {
    return prisma.processInstance.update({ where: { id }, data })
  }

  async updateProcessIfStatusIn(
    id: string,
    statuses: ProcessStatus[],
    data: Partial<{
      status: ProcessInstance['status']
      rootTicketId: string | null
      outputPayload: Prisma.InputJsonValue
      completedAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<ProcessInstance | null> {
    if (statuses.length === 0) return null
    const result = await prisma.processInstance.updateMany({
      where: { id, status: { in: statuses } },
      data,
    })
    if (result.count === 0) return null
    return prisma.processInstance.findFirst({ where: { id } })
  }

  async createStep(input: CreateProcessStepInput): Promise<ProcessStepInstance> {
    return prisma.processStepInstance.create({
      data: {
        tenantId: input.tenantId,
        processInstanceId: input.processInstanceId,
        stepId: input.stepId,
        stepName: input.stepName,
        status: input.status ?? 'pending',
        assignedRole: input.assignedRole,
        assignedAgentId: input.assignedAgentId ?? null,
        assignedUserId: input.assignedUserId ?? null,
        ticketId: input.ticketId ?? null,
      },
    })
  }

  async findStep(
    processInstanceId: string,
    stepId: string,
  ): Promise<ProcessStepInstance | null> {
    return prisma.processStepInstance.findFirst({
      where: { processInstanceId, stepId },
    })
  }

  async findStepByTicket(
    tenantId: string | null,
    ticketId: string,
  ): Promise<ProcessStepInstance | null> {
    return prisma.processStepInstance.findFirst({ where: { tenantId, ticketId } })
  }

  async listSteps(processInstanceId: string): Promise<ProcessStepInstance[]> {
    return prisma.processStepInstance.findMany({
      where: { processInstanceId },
      orderBy: { startedAt: 'asc' },
    })
  }

  async updateStep(
    id: string,
    data: Partial<{
      status: ProcessStepInstance['status']
      ticketId: string | null
      assignedAgentId: string | null
      assignedUserId: string | null
      startedAt: Date | null
      completedAt: Date | null
      failedAt: Date | null
      resultPayload: Prisma.InputJsonValue
    }>,
  ): Promise<ProcessStepInstance> {
    return prisma.processStepInstance.update({ where: { id }, data })
  }

  async createDelegation(input: CreateDelegationEdgeInput): Promise<DelegationEdge> {
    return prisma.delegationEdge.create({
      data: {
        tenantId: input.tenantId,
        processInstanceId: input.processInstanceId,
        fromStepId: input.fromStepId,
        toStepId: input.toStepId,
        fromTicketId: input.fromTicketId ?? null,
        toTicketId: input.toTicketId ?? null,
        fromActorType: input.fromActorType,
        fromAgentId: input.fromAgentId ?? null,
        fromUserId: input.fromUserId ?? null,
        toActorType: input.toActorType,
        toAgentId: input.toAgentId ?? null,
        toUserId: input.toUserId ?? null,
        metadata: input.metadata ?? {},
      },
    })
  }

  async listDelegations(processInstanceId: string): Promise<DelegationEdge[]> {
    return prisma.delegationEdge.findMany({
      where: { processInstanceId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async updateDelegation(
    id: string,
    data: Partial<{
      status: DelegationEdge['status']
      toTicketId: string | null
      deliveredAt: Date | null
      acceptedAt: Date | null
      doneAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<DelegationEdge> {
    return prisma.delegationEdge.update({ where: { id }, data })
  }
}
