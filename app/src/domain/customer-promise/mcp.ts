import { z } from 'zod'
import type { AgentDefinition } from '@/domain/agent-definition'
import type { DefinitionPinDeps } from '@/domain/enterprise-tools/definition-pin'
import type { EnterpriseToolMcpResult, ToolCallPrincipal } from '@/domain/enterprise-tools'
import { auditDenied, authorizeProjectWorkCall } from '@/domain/project-work/mcp'
import type { AuditSink } from '@/lib/audit/types'
import type { CustomerPromiseService } from './customer-promise-service'

// Ugyanaz a gate, mint a work file-oké: passthrough séma, a többletmezőket a gate nem használja.
const definitionId = z.string().uuid().optional()
export const promiseRegisterSchema = z.object({
  definitionId,
  title: z.string().trim().min(1).max(200),
  commitment: z.string().trim().min(1).max(2000),
  dueAt: z.string().datetime({ offset: true }),
  timezone: z.string().max(100).optional(),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().max(320).optional(),
  customerRef: z.string().max(1000).optional(),
  channel: z.enum(['gmail', 'phone', 'other']).optional(),
}).passthrough()
export const promiseGetSchema = z.object({ definitionId, promiseId: z.string().uuid() }).passthrough()
export const promiseListSchema = z.object({
  definitionId,
  status: z.enum(['open', 'claimed', 'fulfilled', 'cancelled', 'missed']).optional(),
  due: z.enum(['upcoming', 'overdue', 'all']).optional(),
}).passthrough()
export const promiseResolveSchema = promiseGetSchema.extend({ note: z.string().max(500).optional() }).passthrough()
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
  audit?: AuditSink
}
function result(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return { ...(isError ? {isError: true as const} : {}), content: [{type: 'text', text: JSON.stringify(payload)}] }
}
function schemaFor(toolName: string) {
  return toolName === 'platform.promise.register' ? promiseRegisterSchema
    : toolName === 'platform.promise.list' ? promiseListSchema
      : toolName === 'platform.promise.get' ? promiseGetSchema : promiseResolveSchema
}
export async function invokeCustomerPromise(deps: CustomerPromiseMcpDeps, input: {
  principal: ToolCallPrincipal; toolName: string; args: Record<string, unknown>
}): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args } = input
  if (!isCustomerPromiseTool(toolName)) return result({code: 'not_found'}, true)
  const authorized = await authorizeProjectWorkCall(deps, principal, toolName, args, schemaFor(toolName), toolName === 'platform.promise.list' ? 'view' : 'operate')
  if (!authorized.ok) return authorized.result
  const { definition, parsed } = authorized
  const fail = async (code: string) => {
    await auditDenied(deps, principal, toolName, code, definition.definitionId, definition.agentId)
    return result({code}, true)
  }
  const svc = deps.customerPromises
  if (toolName === 'platform.promise.register') {
    const fields = parsed as z.infer<typeof promiseRegisterSchema>
    const outcome = await svc.register({
      title: fields.title, commitment: fields.commitment, dueAt: fields.dueAt, timezone: fields.timezone,
      customerName: fields.customerName, customerEmail: fields.customerEmail, customerRef: fields.customerRef, channel: fields.channel,
      tenantId: principal.tenantId, agentId: definition.agentId, ownerUserId: principal.userId, definitionId: definition.definitionId,
    })
    return outcome.ok ? result(outcome) : fail(outcome.code)
  }
  if (toolName === 'platform.promise.list') {
    const fields = parsed as z.infer<typeof promiseListSchema>
    const fetched = await svc.list({tenantId: principal.tenantId, ownerUserId: principal.userId, agentId: definition.agentId, status: fields.status ?? 'active', due: fields.due, limit: 51})
    return result({ok: true, hasMore: fetched.length > 50, promises: fetched.slice(0, 50)})
  }
  const fields = parsed as z.infer<typeof promiseResolveSchema>
  const found = await svc.get({tenantId: principal.tenantId, userId: principal.userId, promiseId: fields.promiseId})
  if (!found.ok) return fail(found.code)
  if (found.row.agentId !== definition.agentId) return fail('not_found')
  if (toolName === 'platform.promise.get') return result(found)
  const outcome = await svc.resolve({tenantId: principal.tenantId, actorUserId: principal.userId, promiseId: fields.promiseId, status: toolName === 'platform.promise.complete' ? 'fulfilled' : 'cancelled', note: fields.note})
  return outcome.ok ? result(outcome) : fail(outcome.code)
}
