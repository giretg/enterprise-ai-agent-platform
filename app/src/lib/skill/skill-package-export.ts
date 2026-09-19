import type { SkillAttachment } from './skill-attachments'
import type { SkillContent, SkillRequirement } from './skill-content'
import { serializeSkillMd } from './skill-md-export'
import { buildStoredZip } from './zip-writer'

export function buildSkillPackageZip(input: {
  name: string
  displayName?: string | null
  description: string
  license?: string | null
  content: SkillContent
  requires: SkillRequirement[]
  attachments: SkillAttachment[]
}): { bytes: Uint8Array; filename: string } {
  const skillMd = serializeSkillMd(input)
  const entries = [
    { path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd) },
    ...input.attachments.map((attachment) => ({
      path: attachment.path.replace(/\\/g, '/').replace(/^\/+/, ''),
      bytes: new TextEncoder().encode(attachment.text),
    })),
  ]

  const bytes = buildStoredZip(entries)
  const filename = `${input.name}.zip`
  return { bytes, filename }
}
