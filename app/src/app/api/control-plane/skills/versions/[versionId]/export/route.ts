import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { parseSkillContent, parseSkillRequires } from '@/lib/skill/skill-content'
import { parseSkillAttachments } from '@/lib/skill/skill-attachments'
import { buildSkillPackageZip } from '@/lib/skill/skill-package-export'

export const runtime = 'nodejs'

function attachmentFilename(skillName: string, version: number): string {
  return `${skillName}-v${version}.zip`
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ versionId: string }> },
) {
  try {
    const ctx = await requireTenantRole('operator')
    const { versionId } = await context.params
    const version = await repositories.skills.findVersionById(versionId)
    if (!version) {
      return new Response('A skill-verzió nem található.', { status: 404 })
    }

    const skill = await repositories.skills.findById(version.skillId)
    if (!skill) {
      return new Response('A skill nem található.', { status: 404 })
    }

    const readable = await services.skills.getReadableSkill(ctx.activeTenantId, skill.id)
    if (!readable) {
      return new Response('A skill nem olvasható ebből a tenantból.', { status: 403 })
    }

    const { bytes } = buildSkillPackageZip({
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      license: skill.license,
      content: parseSkillContent(version.content),
      requires: parseSkillRequires(version.requires),
      attachments: parseSkillAttachments(version.attachments),
    })

    const downloadName = attachmentFilename(skill.name, version.version)
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response('Nincs jogosultság a skill exportálásához.', { status: 403 })
  }
}
