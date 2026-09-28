import { z } from 'zod'
import { KNOWLEDGE_PLACEMENT_TABLE_REF, suggestToolForPlacement } from '@/lib/agent-knowledge-placement'
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
export const MCP_WORK_FILE_APPEND_TOOL = 'platform.work_file.append'
export const MCP_WORK_FILE_DELETE_TOOL = 'platform.work_file.delete'
export const MCP_PROJECT_MEMORY_READ_TOOL = 'platform.project_memory.read'
export const MCP_PROJECT_MEMORY_WRITE_TOOL = 'platform.project_memory.write'
export const MCP_HANDOFF_TOOL = 'platform.handoff'
export const MCP_HANDOFF_ACK_TOOL = 'platform.handoff_ack'

export const PROJECT_WORK_TOOLS = [
  MCP_PROJECTS_LIST_TOOL,
  MCP_PROJECTS_CREATE_TOOL,
  MCP_WORK_FILE_LIST_TOOL,
  MCP_WORK_FILE_READ_TOOL,
  MCP_WORK_FILE_WRITE_TOOL,
  MCP_WORK_FILE_APPEND_TOOL,
  MCP_WORK_FILE_DELETE_TOOL,
  MCP_PROJECT_MEMORY_READ_TOOL,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
  MCP_HANDOFF_TOOL,
  MCP_HANDOFF_ACK_TOOL,
] as const

export type ProjectWorkTool = (typeof PROJECT_WORK_TOOLS)[number]

const PROJECT_WORK_TOOL_SET = new Set<string>(PROJECT_WORK_TOOLS)

export function isProjectWorkTool(toolName: string): toolName is ProjectWorkTool {
  return PROJECT_WORK_TOOL_SET.has(toolName)
}

export function isProjectMemoryWriteTool(toolName: string): boolean {
  return toolName === MCP_PROJECT_MEMORY_WRITE_TOOL
}

function splitIds(value: string): string[] {
  return value.split(',').map((id) => id.trim()).filter(Boolean)
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
const workFileBody = {
  content: z.string().max(200_000).optional().describe('File body as text.'),
  contentBase64: z
    .string()
    .max(270_000)
    .optional()
    .describe(
      'Base64-encoded UTF-8 text (HTML report, CSV, JSON) instead of content. Pass exactly one of content or contentBase64. Real binary (image, PDF) belongs in google_drive_upload_file.',
    ),
}
export const workFileWriteInputSchema = z
  .object({
    definitionId,
    projectKey,
    path: z.string().min(1).max(240),
    ...workFileBody,
  })
  .passthrough()
export const workFileAppendInputSchema = z
  .object({
    definitionId,
    projectKey,
    path: z.string().min(1).max(240),
    ...workFileBody,
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
    ids: z
      .string()
      .max(4_000)
      .refine((value) => splitIds(value).every((id) => z.string().uuid().safeParse(id).success))
      .optional()
      .describe(
        'Comma-separated item ids (from memoryIndex or a prior read). Returns full text for those items only.',
      ),
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Search titles and bodies; returns matching items with full text.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Pagination offset when listing the memory catalog (id, kind, title, createdAt).'),
  })
  .passthrough()
export const projectMemoryWriteInputSchema = z
  .object({
    definitionId,
    projectKey,
    kind: z
      .enum([
        'decision',
        'open_task',
        'finding',
        'constraint',
        'artifact',
        'handoff_summary',
        'focus',
        'session_log',
      ])
      .describe(
        `focus = the agent's current state (what we are doing now, the next step, what we wait for). There is only ever one active focus per agent and project: this write always replaces it. session_log = append-only work journal when a task or conversation ends (what you did, outcome, next step) — never use replaceId. Any other kind is a short company fact or decision — not a rule, plan, or document; those return wrong_placement with the suggested tool. ${KNOWLEDGE_PLACEMENT_TABLE_REF}`,
      ),
    title: z
      .string()
      .max(200)
      .optional()
      .describe('Short label. Optional for focus (defaults to "Fókusz") and session_log (defaults to "Session log").'),
    body: z
      .string()
      .min(1)
      .max(8_000)
      .describe('Max 3000 characters for focus.'),
    artifactPath: z
      .string()
      .max(240)
      .optional()
      .describe('Work-file path this memory points at (the plan lives in the file, not here).'),
    replaceId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'id of an existing item (from platform.project_memory.read) that this write updates or corrects. The old item is retired. Use it whenever the new fact is about the same subject — never leave an outdated item next to its correction.',
      ),
    // Nem tömb: a Claude.ai tömb-mezős tool-sémát nem kezel jól (mcp-http teszt őrzi).
    mergeIds: z
      .string()
      .max(400)
      .refine((value) => splitIds(value).every((id) => z.string().uuid().safeParse(id).success))
      .optional()
      .describe(
        'Comma-separated ids of further existing items about the same subject that this write consolidates. They are retired together with replaceId, leaving one current item. Use this instead of writing one correction per outdated item.',
      ),
    confirmNew: z
      .boolean()
      .optional()
      .describe(
        'Set true only after a possible_duplicate response, when none of the returned candidates is about the same subject.',
      ),
    confirmMisplaced: z
      .boolean()
      .optional()
      .describe(
        'Set true only after wrong_placement when the text is genuinely a short fact that belongs in memory despite the heuristic.',
      ),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export function schemaForProjectWorkTool(toolName: string) {
  if (toolName === MCP_PROJECTS_CREATE_TOOL) return projectsCreateInputSchema
  if (toolName === MCP_WORK_FILE_LIST_TOOL) return workFileListInputSchema
  if (toolName === MCP_WORK_FILE_READ_TOOL) return workFileReadInputSchema
  if (toolName === MCP_WORK_FILE_WRITE_TOOL) return workFileWriteInputSchema
  if (toolName === MCP_WORK_FILE_APPEND_TOOL) return workFileAppendInputSchema
  if (toolName === MCP_WORK_FILE_DELETE_TOOL) return workFileDeleteInputSchema
  if (toolName === MCP_PROJECT_MEMORY_READ_TOOL) return projectMemoryReadInputSchema
  if (toolName === MCP_PROJECT_MEMORY_WRITE_TOOL) return projectMemoryWriteInputSchema
  if (toolName === MCP_HANDOFF_TOOL) return handoffInputSchema
  if (toolName === MCP_HANDOFF_ACK_TOOL) return handoffAckInputSchema
  return projectsListInputSchema
}

export const handoffInputSchema = z
  .object({
    definitionId,
    projectKey,
    toAgentId: z.string().uuid().optional().describe('Recipient agent id (from platform.agents.list). Exactly one of toAgentId / toUserId.'),
    toUserId: z.string().uuid().optional().describe('Recipient human user id. Exactly one of toAgentId / toUserId.'),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(8_000),
    // ponytail: string not string[] — Claude.ai drops MCP tools whose advertised schema has arrays
    links: z
      .string()
      .max(2_000)
      .optional()
      .describe('Comma-separated links: "label | work_file:/path, label | https://…"'),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const handoffAckInputSchema = z
  .object({
    definitionId,
    handoffId: z.string().uuid(),
    decision: z.enum(['accepted', 'done', 'rejected']),
  })
  .passthrough()

export type ProjectWorkMcpDeps = DefinitionPinDeps & {
  loadDefinition: (input: {
    tenantId: string
    definitionId: string
  }) => Promise<AgentDefinition | null>
  loadDefinitionByAgent?: (input: {
    tenantId: string
    agentId: string
  }) => Promise<AgentDefinition | null>
  findAgentGrant: (input: {
    tenantId: string
    userId: string
    agentId: string
  }) => Promise<{ accessLevel: string } | null>
  canViewAgent?: (input: { tenantId: string; userId: string; role: string; agentId: string }) => Promise<boolean>
  findUserById?: (userId: string) => Promise<{ id: string; tenantId?: string } | null>
  isTenantMember?: (input: { tenantId: string; userId: string }) => Promise<boolean>
  projectWork: ProjectWorkService
  handoffs?: {
    insert(input: {
      tenantId: string
      fromAgentId: string
      fromDefinitionId: string
      toAgentId: string | null
      toUserId: string | null
      projectKey: string
      title: string
      summary: string
      links: string | null
      createdById: string
    }): Promise<{ id: string }>
    findById(id: string): Promise<{
      id: string
      tenantId: string
      fromAgentId: string
      toAgentId: string | null
      toUserId: string | null
      status: string
    } | null>
    attachMemory(id: string, memoryId: string): Promise<void>
    decide(input: {
      id: string
      expectedStatus: 'open' | 'accepted'
      status: 'accepted' | 'done' | 'rejected'
      decidedById: string
    }): Promise<unknown | null>
  }
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
      ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
      ...(typeof parsed.contentBase64 === 'string' ? { contentBase64: parsed.contentBase64 } : {}),
      userId: principal.userId,
    })
  } else if (toolName === MCP_WORK_FILE_APPEND_TOOL) {
    outcome = await svc.appendFile({
      tenantId,
      projectKey,
      path: String(parsed.path),
      ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
      ...(typeof parsed.contentBase64 === 'string' ? { contentBase64: parsed.contentBase64 } : {}),
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
      ids: typeof parsed.ids === 'string' ? splitIds(parsed.ids) : undefined,
      query: typeof parsed.query === 'string' ? parsed.query : undefined,
      offset: typeof parsed.offset === 'number' ? parsed.offset : undefined,
    })
  } else if (toolName === MCP_HANDOFF_TOOL) {
    return invokeHandoff(deps, principal, definition, parsed)
  } else if (toolName === MCP_HANDOFF_ACK_TOOL) {
    return invokeHandoffAck(deps, principal, definition, parsed)
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
      // title: focusednél elhagyható (a service ad alapértelmezést), más típusnál kötelező.
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: String(parsed.body),
      artifactPath: typeof parsed.artifactPath === 'string' ? parsed.artifactPath : undefined,
      replaceId: typeof parsed.replaceId === 'string' ? parsed.replaceId : undefined,
      mergeIds: typeof parsed.mergeIds === 'string' ? splitIds(parsed.mergeIds) : undefined,
      confirmNew: parsed.confirmNew === true,
      confirmMisplaced: parsed.confirmMisplaced === true,
      withUserId: principal.userId,
      mode: modeRes.mode,
    })
    if (!written.ok) {
      await auditDenied(deps, principal, toolName, written.code, definition.definitionId, definition.agentId)
      return errorResult(written.code)
    }
    if (written.status === 'possible_duplicate') {
      return textResult({
        status: 'possible_duplicate',
        written: false,
        candidates: written.candidates,
        next:
          'Nothing was written. Candidates about the same subject must end up in ONE current item: call again with replaceId=<one candidate id>, mergeIds="<other matching ids, comma-separated>" (keep any replaceId/mergeIds you already sent) and a merged, up-to-date title/body that states only what is valid now. Only if no candidate is about the same subject, call again with confirmNew=true.',
      })
    }
    if (written.status === 'wrong_placement') {
      return textResult({
        status: 'wrong_placement',
        written: false,
        reason: written.reason,
        suggest: written.suggest,
        useTool: suggestToolForPlacement(written.suggest),
        next: `Nothing was written. This text looks like ${written.reason === 'procedure' ? 'an operating rule or procedure' : 'a long document or plan'}, not a short memory fact. Use ${suggestToolForPlacement(written.suggest)} instead (${KNOWLEDGE_PLACEMENT_TABLE_REF}). Only if it is truly a short fact, retry with confirmMisplaced=true.`,
      })
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
          ...(written.draft.mergeIds ? { mergeIds: written.draft.mergeIds.join(',') } : {}),
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

async function invokeHandoff(
  deps: ProjectWorkMcpDeps,
  principal: ToolCallPrincipal,
  definition: AgentDefinition,
  parsed: Record<string, unknown>,
): Promise<EnterpriseToolMcpResult> {
  if (!deps.handoffs || !deps.loadDefinitionByAgent) return errorResult('tool_not_configured')
  const { validateHandoffInput, normalizeHandoffProjectKey, formatHandoffMemoryBody } = await import(
    '@/domain/handoff/handoff-service'
  )
  const validated = validateHandoffInput({
    toAgentId: parsed.toAgentId,
    toUserId: parsed.toUserId,
    title: parsed.title,
    summary: parsed.summary,
    links: parsed.links,
  })
  if (!validated.ok) {
    await auditDenied(deps, principal, MCP_HANDOFF_TOOL, validated.code, definition.definitionId, definition.agentId)
    return errorResult(validated.code)
  }
  const toAgentId = typeof parsed.toAgentId === 'string' && parsed.toAgentId.trim() ? parsed.toAgentId.trim() : null
  const toUserId = typeof parsed.toUserId === 'string' && parsed.toUserId.trim() ? parsed.toUserId.trim() : null
  const projectKey = normalizeHandoffProjectKey(parsed.projectKey)

  if (toAgentId) {
    const target = await deps.loadDefinitionByAgent({ tenantId: principal.tenantId, agentId: toAgentId })
    if (!target) {
      await auditDenied(deps, principal, MCP_HANDOFF_TOOL, 'definition_not_found', definition.definitionId, definition.agentId)
      return errorResult('definition_not_found')
    }
    if (!isDispatchable(target.status)) {
      await auditDenied(deps, principal, MCP_HANDOFF_TOOL, 'agent_inactive', definition.definitionId, definition.agentId)
      return errorResult('agent_inactive')
    }
    if (deps.canViewAgent) {
      const visible = await deps.canViewAgent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        role: principal.role,
        agentId: toAgentId,
      })
      if (!visible) {
        await auditDenied(deps, principal, MCP_HANDOFF_TOOL, 'agent_access_denied', definition.definitionId, definition.agentId)
        return errorResult('agent_access_denied')
      }
    }
    if (toAgentId === definition.agentId) {
      await auditDenied(deps, principal, MCP_HANDOFF_TOOL, 'invalid_args', definition.definitionId, definition.agentId)
      return errorResult('invalid_args')
    }
  }
  if (toUserId && deps.isTenantMember) {
    const member = await deps.isTenantMember({ tenantId: principal.tenantId, userId: toUserId })
    if (!member) {
      await auditDenied(deps, principal, MCP_HANDOFF_TOOL, 'agent_access_denied', definition.definitionId, definition.agentId)
      return errorResult('agent_access_denied')
    }
  }

  const handoff = await deps.handoffs.insert({
    tenantId: principal.tenantId,
    fromAgentId: definition.agentId,
    fromDefinitionId: definition.definitionId,
    toAgentId,
    toUserId,
    projectKey,
    title: validated.title,
    summary: validated.summary,
    links: validated.links,
    createdById: principal.userId,
  })

  // Trusted intra-tenant write: bypasses the recipient's approval mode so the
  // handed-off task is visible immediately; the source is stamped in the body.
  let memoryId: string | null = null
  if (toAgentId) {
    const written = await deps.projectWork.writeMemory({
      tenantId: principal.tenantId,
      agentId: toAgentId,
      projectKey,
      kind: 'open_task',
      title: validated.title,
      body: formatHandoffMemoryBody({
        fromAgentName: definition.snapshot.name,
        summary: validated.summary,
        links: validated.links,
        handoffId: handoff.id,
      }),
      withUserId: principal.userId,
      confirmNew: true,
      mode: 'direct',
    })
    if (written.ok && written.status === 'written') {
      memoryId = written.item.id
      await deps.handoffs.attachMemory(handoff.id, written.item.id)
    }
  }

  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'handoff.created',
    targetType: 'agent',
    targetId: toAgentId ?? null,
    modelUsed: null,
    inputRef: MCP_HANDOFF_TOOL,
    outputRef: handoff.id,
    policyDecision: 'allowed',
    metadata: {
      toolName: MCP_HANDOFF_TOOL,
      tenantId: principal.tenantId,
      fromAgentId: definition.agentId,
      fromDefinitionId: definition.definitionId,
      toAgentId,
      toUserId,
      projectKey,
      memoryId,
    },
    tenantId: principal.tenantId,
  })
  await auditOk(deps, principal, MCP_HANDOFF_TOOL, definition.definitionId, definition.agentId)
  return textResult({ ok: true, handoffId: handoff.id, memoryId, projectKey, notified: toAgentId ? 'agent_memory' : 'inbox' })
}

async function invokeHandoffAck(
  deps: ProjectWorkMcpDeps,
  principal: ToolCallPrincipal,
  definition: AgentDefinition,
  parsed: Record<string, unknown>,
): Promise<EnterpriseToolMcpResult> {
  if (!deps.handoffs) return errorResult('tool_not_configured')
  const handoffId = asUuid(parsed.handoffId)
  if (!handoffId) {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'invalid_args', definition.definitionId, definition.agentId)
    return errorResult('invalid_args')
  }
  const row = await deps.handoffs.findById(handoffId)
  if (!row || row.tenantId !== principal.tenantId) {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'definition_not_found', definition.definitionId, definition.agentId)
    return errorResult('definition_not_found')
  }
  const decision = String(parsed.decision)
  if (decision !== 'accepted' && decision !== 'done' && decision !== 'rejected') {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'invalid_args', definition.definitionId, definition.agentId)
    return errorResult('invalid_args')
  }
  // Only the recipient side (or anyone operating the recipient agent) may ack.
  const isRecipientAgent = row.toAgentId === definition.agentId
  const isRecipientUser = row.toUserId === principal.userId
  if (!isRecipientAgent && !isRecipientUser) {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'agent_access_denied', definition.definitionId, definition.agentId)
    return errorResult('agent_access_denied')
  }
  if (row.status !== 'open' && row.status !== 'accepted') {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'approval_already_decided', definition.definitionId, definition.agentId)
    return errorResult('approval_already_decided')
  }
  const updated = await deps.handoffs.decide({
    id: handoffId,
    expectedStatus: row.status,
    status: decision,
    decidedById: principal.userId,
  })
  if (!updated) {
    await auditDenied(deps, principal, MCP_HANDOFF_ACK_TOOL, 'approval_already_decided', definition.definitionId, definition.agentId)
    return errorResult('approval_already_decided')
  }
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'handoff.acknowledged',
    targetType: 'agent',
    targetId: row.toAgentId ?? null,
    modelUsed: null,
    inputRef: MCP_HANDOFF_ACK_TOOL,
    outputRef: handoffId,
    policyDecision: 'allowed',
    metadata: { toolName: MCP_HANDOFF_ACK_TOOL, tenantId: principal.tenantId, decision, handoffId },
    tenantId: principal.tenantId,
  })
  await auditOk(deps, principal, MCP_HANDOFF_ACK_TOOL, definition.definitionId, definition.agentId)
  return textResult({ ok: true, handoffId, status: decision })
}
