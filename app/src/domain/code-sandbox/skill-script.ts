import { classifyPackageFile } from '@/lib/skill/skill-package-adapter'
import { parseSkillAttachments, type SkillAttachment } from '@/lib/skill/skill-attachments'
import type { AgentDefinition } from '@/domain/agent-definition'
import { normalizeWorkFilePath } from '@/lib/work-project'
import { normalizeSandboxWorkspacePath } from './code-sandbox-types'

/** Claude.ai drops MCP tools whose advertised schema has arrays — keep a string field. */
export const MAX_SANDBOX_WORK_INPUTS = 16
export const SANDBOX_WORK_INPUT_PREFIX = '/work/in/'

export type ResolvedSkillScript = {
  skillName: string
  entry: SkillAttachment
  helpers: SkillAttachment[]
}

export type ResolveSkillScriptResult =
  | { ok: true; script: ResolvedSkillScript }
  | { ok: false; reason: string }

export function splitSandboxArgs(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.trim().split(/\s+/).filter(Boolean)
}

export function splitSandboxInputs(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export type ResolvedSandboxWorkInput = {
  workPath: string
  sandboxPath: string
}

type ResolveSandboxWorkInputResult =
  | ({ ok: true } & ResolvedSandboxWorkInput)
  | { ok: false; reason: string }

export type ResolveSandboxWorkInputsResult =
  | { ok: true; inputs: ResolvedSandboxWorkInput[] }
  | { ok: false; reason: string }

function resolveSandboxWorkInput(raw: string): ResolveSandboxWorkInputResult {
  const workPath = normalizeWorkFilePath(raw)
  if (!workPath) return { ok: false, reason: 'invalid_args' }
  if (workPath === 'skill' || workPath.startsWith('skill/')) return { ok: false, reason: 'invalid_args' }
  try {
    normalizeSandboxWorkspacePath(workPath)
  } catch {
    return { ok: false, reason: 'invalid_args' }
  }
  return { ok: true, workPath, sandboxPath: `${SANDBOX_WORK_INPUT_PREFIX}${workPath}` }
}

export function resolveSandboxWorkInputs(value: unknown): ResolveSandboxWorkInputsResult {
  const parts = splitSandboxInputs(value)
  if (parts.length > MAX_SANDBOX_WORK_INPUTS) return { ok: false, reason: 'invalid_args' }
  const seen = new Set<string>()
  const inputs: ResolvedSandboxWorkInput[] = []
  for (const part of parts) {
    const resolved = resolveSandboxWorkInput(part)
    if (!resolved.ok) return resolved
    if (seen.has(resolved.workPath)) return { ok: false, reason: 'invalid_args' }
    seen.add(resolved.workPath)
    inputs.push({ workPath: resolved.workPath, sandboxPath: resolved.sandboxPath })
  }
  return { ok: true, inputs }
}

export function sandboxWorkFilePrefix(skillName: string): string {
  const safe = skillName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `sandbox-output/${safe || 'skill'}`
}

export function resolvePinnedSkillScript(input: {
  definition: AgentDefinition
  skillVersionId: string
  entry: string
  attachments: unknown
}): ResolveSkillScriptResult {
  const pin = input.definition.snapshot.skills.find(
    (row) => row.skillVersionId === input.skillVersionId,
  )
  if (!pin) return { ok: false, reason: 'skill_not_pinned' }

  let entryPath: string
  try {
    entryPath = normalizeSandboxWorkspacePath(input.entry.trim())
  } catch {
    return { ok: false, reason: 'invalid_args' }
  }

  const attachments = parseSkillAttachments(input.attachments)
  const entry = attachments.find((row) => row.path === entryPath)
  if (!entry) return { ok: false, reason: 'skill_entry_not_found' }
  if (classifyPackageFile(entry.path) !== 'code' || !entry.path.toLowerCase().endsWith('.py')) {
    return { ok: false, reason: 'skill_entry_not_runnable' }
  }

  const helpers = attachments.filter(
    (row) => row.path !== entry.path && classifyPackageFile(row.path) === 'code',
  )
  return { ok: true, script: { skillName: pin.name, entry, helpers } }
}
