import { z } from 'zod'
import { canOperateAgent, canReadPublishedAgent, type AgentDefinition } from '@/domain/agent-definition'
import { checkDefinitionPin, type DefinitionPinDeps } from '@/domain/enterprise-tools/definition-pin'
import type { EnterpriseToolMcpResult, ToolCallPrincipal } from '@/domain/enterprise-tools'
import { isDispatchable } from '@/lib/agent-lifecycle'
import type { CustomerPromiseService } from './customer-promise-service'

const definitionId = z.string().uuid().optional()
export const promiseRegisterSchema = z.object({
  definitionId,
  title: z.string().trim().min(1).max(200),
  commitment: z.string().trim().min(1).max(2000),
  dueAt: z.string().datetime({ offset: true }),
  timezone: z.string().max(100).optional(),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().max(320).optional(),
  customerRef: z.string().max(500).optional(),
  channel: z.enum(['gmail', 'phone', 'other']).optional(),
}).strict()
export const promiseGetSchema = z.object({ definitionId, promiseId: z.string().uuid() }).strict()
export const promiseListSchema = z.object({
  definitionId,
  status: z.enum(['open', 'claimed', 'fulfilled', 'cancelled', 'missed']).optional(),
  due: z.enum(['upcoming', 'overdue', 'all']).optional(),
}).strict()
export const promiseResolveSchema = promiseGetSchema.extend({ note: z.string().max(500).optional() }).strict()
export const CUSTOMER_PROMISE_TOOLS = [
  'platform.promise.register', 'platform.promise.get', 'platform.promise.list',
  'platform.promise.complete', 'platform.promise.cancel',
] as const
export function isCustomerPromiseTool(name: string): boolean {
  return (CUSTOMER_PROMISE_TOOLS as readonly string[]).includes(name)
}
export type CustomerPromiseMcpDeps = DefinitionPinDeps & {
  loadDefinition(input: {tenantId: string; definitionId: string}): Promise<AgentDefinition | null>
  findAgentGrant(input: {tenantId: string; userId: string; agentId: string}): Promise<{accessLevel: string} | null>
  customerPromises: CustomerPromiseService
}
function result(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return { ...(isError ? {isError: true as const} : {}), content: [{type: 'text', text: JSON.stringify(payload)}] }
}
export async function invokeCustomerPromise(deps: CustomerPromiseMcpDeps, input: {
  principal: ToolCallPrincipal; toolName: string; args: Record<string, unknown>
}): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args } = input
  const fail = (code: string) => result({code}, true)
  const schema = toolName === 'platform.promise.register' ? promiseRegisterSchema
    : toolName === 'platform.promise.list' ? promiseListSchema
      : toolName === 'platform.promise.get' ? promiseGetSchema : promiseResolveSchema
  if (!isCustomerPromiseTool(toolName)) return fail('not_found')
  const parsed = schema.safeParse(args)
  if (!parsed.success || !parsed.data.definitionId) return fail('invalid_args')
  const definition = await deps.loadDefinition({tenantId: principal.tenantId, definitionId: parsed.data.definitionId})
  if (!definition || definition.tenantId !== principal.tenantId) return fail('not_found')
  if (!isDispatchable(definition.status)) return fail('not_allowed')
  if (!(await checkDefinitionPin(deps, {tenantId: principal.tenantId, definition})).current) return fail('not_allowed')
  const grant = await deps.findAgentGrant({tenantId: principal.tenantId, userId: principal.userId, agentId: definition.agentId})
  const allowed = toolName === 'platform.promise.list'
    ? canReadPublishedAgent({role: principal.role, grant})
    : canOperateAgent({role: principal.role, grant, assumed: principal.assumed})
  if (!allowed) return fail('not_allowed')
  const svc = deps.customerPromises
  const scope = {tenantId: principal.tenantId, userId: principal.userId}
  if (toolName === 'platform.promise.register') {
    const fields = promiseRegisterSchema.parse(args)
    const outcome = await svc.register({...fields, tenantId: principal.tenantId, agentId: definition.agentId, ownerUserId: principal.userId, definitionId: definition.definitionId})
    return outcome.ok ? result(outcome) : fail(outcome.code)
  }
  if (toolName === 'platform.promise.list') {
    const fields = promiseListSchema.parse(args)
    return result({ok: true, promises: await svc.list({tenantId: principal.tenantId, ownerUserId: principal.userId, agentId: definition.agentId, status: fields.status ?? 'active', due: fields.due, limit: 50})})
  }
  const fields = promiseResolveSchema.parse(args)
  const found = await svc.get({...scope, promiseId: fields.promiseId})
  if (!found.ok) return fail(found.code)
  if (found.row.agentId !== definition.agentId) return fail('not_found')
  if (toolName === 'platform.promise.get') return result(found)
  const outcome = await svc.resolve({tenantId: principal.tenantId, actorUserId: principal.userId, promiseId: fields.promiseId, status: toolName === 'platform.promise.complete' ? 'fulfilled' : 'cancelled', note: fields.note})
  return outcome.ok ? result(outcome) : fail(outcome.code)
}
