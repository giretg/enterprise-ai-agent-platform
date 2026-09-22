import { z } from 'zod'
import { canOperateAgent, type AgentDefinition } from '@/domain/agent-definition'
import { checkDefinitionPin, type DefinitionPinDeps } from '@/domain/enterprise-tools/definition-pin'
import {
  asUuid,
  enterpriseToolErrorPayload,
  type EnterpriseToolMcpResult,
  type ToolCallPrincipal,
} from '@/domain/enterprise-tools'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { writeAudit, type AuditSink } from '@/lib/audit/types'
import { ProjectWorkService } from './project-work-service'

export const MCP_PROJECTS_LIST_TOOL = 'platform.projects.list'
export const MCP_PROJECTS_CREATE_TOOL = 'platform.projects.create'
export const MCP_WORK_FILE_LIST_TOOL = 'platform.work_file.list'
export const MCP_WORK_FILE_READ_TOOL = 'platform.work_file.read'
export const MCP_WORK_FILE_WRITE_TOOL = 'platform.work_file.write'
export const MCP_WORK_FILE_DELETE_TOOL = 'platform.work_file.delete'
export const MCP_PROJECT_MEMORY_READ_TOOL = 'platform.project_memory.read'
export const MCP_PROJECT_MEMORY_WRITE_TOOL = 'platform.project_memory.write'

export const PROJECT_WORK_TOOLS = [
  MCP_PROJECTS_LIST_TOOL,
  MCP_PROJECTS_CREATE_TOOL,
  MCP_WORK_FILE_LIST_TOOL,
  MCP_WORK_FILE_READ_TOOL,
  MCP_WORK_FILE_WRITE_TOOL,
  MCP_WORK_FILE_DELETE_TOOL,
  MCP_PROJECT_MEMORY_READ_TOOL,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
] as const

export type ProjectWorkTool = (typeof PROJECT_WORK_TOOLS)[number]

const PROJECT_WORK_TOOL_SET = new Set<string>(PROJECT_WORK_TOOLS)

export function isProjectWorkTool(toolName: string): toolName is ProjectWorkTool {
  return PROJECT_WORK_TOOL_SET.has(toolName)
}

export function isProjectMemoryWriteTool(toolName: string): boolean {
  return toolName === MCP_PROJECT_MEMORY_WRITE_TOOL
}

const definitionId = z
  .string()
  .uuid()
  .describe('Published agent definition id — from platform.agent.get_definition')
const projectKey = z
  .string()
  .max(120)
  .optional()
  .describe('Project key. Omit for the built-in __general__ project.')

export const projectsListInputSchema = z.object({ definitionId }).passthrough()
export const projectsCreateInputSchema = z
  .object({
    definitionId,
    name: z.string().min(1).max(120),
    key: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
  })
  .passthrough()
export const workFileListInputSchema = z
  .object({
    definitionId,
    projectKey,
    prefix: z.string().max(240).optional(),
  })
  .passthrough()
export const workFileReadInputSchema = z
  .object({
    definitionId,
    projectKey,
    path: z.string().min(1).max(240),
  })
  .passthrough()
export const workFileWriteInputSchema = z
  .object({
    definitionId,
    projectKey,
    path: z.string().min(1).max(240),
    content: z.string().max(200_000),
  })
  .passthrough()
export const workFileDeleteInputSchema = z
  .object({
    definitionId,
    projectKey,
    path: z.string().min(1).max(240),
  })
  .passthrough()
export const projectMemoryReadInputSchema = z
  .object({
    definitionId,
    projectKey,
    mine: z
      .boolean()
      .optional()
      .describe('If true, only return items stamped with the calling user (this conversation partner).'),
  })
  .passthrough()
export const projectMemoryWriteInputSchema = z
  .object({
    definitionId,
    projectKey,
    kind: z.enum(['decision', 'open_task', 'finding', 'constraint', 'artifact', 'handoff_summary']),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8_000),
    artifactPath: z
      .string()
      .max(240)
      .optional()
      .describe('Work-file path this memory points at (the plan lives in the file, not here).'),
    replaceId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export function schemaForProjectWorkTool(toolName: string) {
  if (toolName === MCP_PROJECTS_CREATE_TOOL) return projectsCreateInputSchema
  if (toolName === MCP_WORK_FILE_LIST_TOOL) return workFileListInputSchema
  if (toolName === MCP_WORK_FILE_READ_TOOL) return workFileReadInputSchema
  if (toolName === MCP_WORK_FILE_WRITE_TOOL) return workFileWriteInputSchema
  if (toolName === MCP_WORK_FILE_DELETE_TOOL) return workFileDeleteInputSchema
  if (toolName === MCP_PROJECT_MEMORY_READ_TOOL) return projectMemoryReadInputSchema
  if (toolName === MCP_PROJECT_MEMORY_WRITE_TOOL) return projectMemoryWriteInputSchema
  return projectsListInputSchema
}

export type ProjectWorkMcpDeps = DefinitionPinDeps & {
  loadDefinition: (input: {
    tenantId: string
    definitionId: string
  }) => Promise<AgentDefinition | null>
  findAgentGrant: (input: {
    tenantId: string
    userId: string
    agentId: string
  }) => Promise<{ accessLevel: string } | null>
  projectWork: ProjectWorkService
  enqueueMemoryWrite?: (input: {
    principal: ToolCallPrincipal
    args: Record<string, unknown>
    origin?: string
  }) => Promise<EnterpriseToolMcpResult>
  audit?: AuditSink
}

function textResult(payload: unknown, isError = false): EnterpriseToolMcpResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

function errorResult(code: string, extra?: Record<string, unknown>): EnterpriseToolMcpResult {
  return textResult(enterpriseToolErrorPayload(code, extra), true)
}

async function auditDenied(
  deps: ProjectWorkMcpDeps,
  principal: ToolCallPrincipal,
  toolName: string,
  reason: string,
  definitionId?: string,
  agentId?: string,
) {
  const payload = {
    toolName,
    reasonCode: reason,
    tenantId: principal.tenantId,
    userId: principal.userId,
    ...(definitionId ? { definitionId } : {}),
    ...(agentId ? { agentId } : {}),
  }
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'enterprise.tool.denied',
    targetType: 'agent',
    targetId: agentId ?? null,
    modelUsed: null,
    inputRef: toolName,
    outputRef: reason,
    policyDecision: 'denied',
    metadata: payload,
    tenantId: principal.tenantId,
  })
}

async function auditOk(
  deps: ProjectWorkMcpDeps,
  principal: ToolCallPrincipal,
  toolName: string,
  definitionId: string,
  agentId: string,
) {
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'enterprise.tool.ok',
    targetType: 'agent',
    targetId: agentId,
    modelUsed: null,
    inputRef: toolName,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: {
      toolName,
      tenantId: principal.tenantId,
      userId: principal.userId,
      definitionId,
      agentId,
    },
    tenantId: principal.tenantId,
  })
}

export async function authorizeProjectWorkCall(
  deps: ProjectWorkMcpDeps,
  principal: ToolCallPrincipal,
  toolName: string,
  args: Record<string, unknown>,
): Promise<
  | { ok: true; definition: AgentDefinition; parsed: Record<string, unknown> }
  | { ok: false; result: EnterpriseToolMcpResult }
> {
  const definitionId = asUuid(args.definitionId)
  if (!definitionId) {
    await auditDenied(deps, principal, toolName, 'definition_not_found')
    return { ok: false, result: errorResult('definition_not_found') }
  }
  const definition = await deps.loadDefinition({ tenantId: principal.tenantId, definitionId })
  if (!definition) {
    await auditDenied(deps, principal, toolName, 'definition_not_found', definitionId)
    return { ok: false, result: errorResult('definition_not_found') }
  }
  if (!isDispatchable(definition.status)) {
    await auditDenied(deps, principal, toolName, 'agent_inactive', definitionId, definition.agentId)
    return { ok: false, result: errorResult('agent_inactive') }
  }
  const pin = await checkDefinitionPin(deps, { tenantId: principal.tenantId, definition })
  if (!pin.current) {
    await auditDenied(deps, principal, toolName, 'agent_stale', definitionId, definition.agentId)
    return {
      ok: false,
      result: errorResult('agent_stale', {
        agentId: definition.agentId,
        definitionId,
        currentDefinitionId: pin.currentDefinitionId,
      }),
    }
  }
  const grant = await deps.findAgentGrant({
    tenantId: principal.tenantId,
    userId: principal.userId,
    agentId: definition.agentId,
  })
  if (!canOperateAgent({ role: principal.role, grant, assumed: principal.assumed })) {
    await auditDenied(deps, principal, toolName, 'agent_access_denied', definitionId, definition.agentId)
    return { ok: false, result: errorResult('agent_access_denied') }
  }
  const schema = schemaForProjectWorkTool(toolName)
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    await auditDenied(deps, principal, toolName, 'invalid_args', definitionId, definition.agentId)
    return { ok: false, result: errorResult('invalid_args') }
  }
  return { ok: true, definition, parsed: parsed.data as Record<string, unknown> }
}

export async function invokeProjectWork(
  deps: ProjectWorkMcpDeps,
  input: {
    principal: ToolCallPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
  },
): Promise<EnterpriseToolMcpResult> {
  const { principal, toolName, args, origin } = input
  if (!isProjectWorkTool(toolName)) return errorResult('tool_not_configured')
  const authorized = await authorizeProjectWorkCall(deps, principal, toolName, args)
  if (!authorized.ok) return authorized.result
  const { definition, parsed } = authorized
  const svc = deps.projectWork
  const tenantId = principal.tenantId
  const projectKey = typeof parsed.projectKey === 'string' ? parsed.projectKey : undefined

  let outcome: { ok: false; code: string; message: string } | { ok: true; [k: string]: unknown }

  if (toolName === MCP_PROJECTS_LIST_TOOL) {
    outcome = { ok: true, projects: await svc.listProjects(tenantId) }
  } else if (toolName === MCP_PROJECTS_CREATE_TOOL) {
    outcome = await svc.createProject({
      tenantId,
      name: String(parsed.name),
      createdById: principal.userId,
      key: typeof parsed.key === 'string' ? parsed.key : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    })
  } else if (toolName === MCP_WORK_FILE_LIST_TOOL) {
    outcome = await svc.listFiles({
      tenantId,
      projectKey,
      prefix: typeof parsed.prefix === 'string' ? parsed.prefix : undefined,
    })
  } else if (toolName === MCP_WORK_FILE_READ_TOOL) {
    outcome = await svc.readFile({ tenantId, projectKey, path: String(parsed.path) })
  } else if (toolName === MCP_WORK_FILE_WRITE_TOOL) {
    outcome = await svc.writeFile({
      tenantId,
      projectKey,
      path: String(parsed.path),
      content: String(parsed.content),
      userId: principal.userId,
    })
  } else if (toolName === MCP_WORK_FILE_DELETE_TOOL) {
    outcome = await svc.deleteFile({ tenantId, projectKey, path: String(parsed.path) })
  } else if (toolName === MCP_PROJECT_MEMORY_READ_TOOL) {
    outcome = await svc.readMemory({
      tenantId,
      agentId: definition.agentId,
      projectKey,
      mine: parsed.mine === true,
      callerUserId: principal.userId,
    })
  } else {
    const modeRes = await svc.getWriteMode(definition.agentId, tenantId)
    if (!modeRes.ok) {
      await auditDenied(deps, principal, toolName, modeRes.code, definition.definitionId, definition.agentId)
      return errorResult(modeRes.code)
    }
    const written = await svc.writeMemory({
      tenantId,
      agentId: definition.agentId,
      projectKey,
      kind: String(parsed.kind),
      title: String(parsed.title),
      body: String(parsed.body),
      artifactPath: typeof parsed.artifactPath === 'string' ? parsed.artifactPath : undefined,
      replaceId: typeof parsed.replaceId === 'string' ? parsed.replaceId : undefined,
      withUserId: principal.userId,
      mode: modeRes.mode,
    })
    if (!written.ok) {
      await auditDenied(deps, principal, toolName, written.code, definition.definitionId, definition.agentId)
      return errorResult(written.code)
    }
    if (written.status === 'needs_approval') {
      if (!deps.enqueueMemoryWrite) return errorResult('tool_not_configured')
      return deps.enqueueMemoryWrite({
        principal,
        args: {
          definitionId: definition.definitionId,
          projectKey: written.draft.projectKey,
          kind: written.draft.kind,
          title: written.draft.title,
          body: written.draft.body,
          ...(written.draft.artifactPath ? { artifactPath: written.draft.artifactPath } : {}),
          ...(written.draft.replaceId ? { replaceId: written.draft.replaceId } : {}),
          idempotencyKey: String(parsed.idempotencyKey),
          withUserId: principal.userId,
        },
        origin,
      })
    }
    await auditOk(deps, principal, toolName, definition.definitionId, definition.agentId)
    return textResult(written)
  }

  if (!outcome.ok) {
    await auditDenied(deps, principal, toolName, outcome.code, definition.definitionId, definition.agentId)
    return errorResult(outcome.code)
  }
  await auditOk(deps, principal, toolName, definition.definitionId, definition.agentId)
  return textResult(outcome)
}
