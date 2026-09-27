import { classifyPackageFile } from '@/lib/skill/skill-package-adapter'
import { parseSkillAttachments, type SkillAttachment } from '@/lib/skill/skill-attachments'
import type { AgentDefinition } from '@/domain/agent-definition'
import { normalizeSandboxWorkspacePath } from './code-sandbox-types'

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
