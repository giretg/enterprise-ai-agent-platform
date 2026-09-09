/**
 * Egyszeri javítás: azoknak a skilleknek, ahol az AKTÍV verzióról hiányoznak a
 * Level-2 fájlok, de egy korábbi verzión még megvoltak, új verziót javasol az
 * aktív tartalommal + a legutóbbi ismert fájlokkal, és aktiválja.
 *
 * Oka: a katalógus „Új verzió” szerkesztője a javításig nem vitte át a
 * mellékleteket, így minden UI-ból készült verzió csendben elhagyta a ZIP-ből
 * importált fájlokat — a skill hivatkozott rájuk, de `load_skill_attachment`
 * már nem találta őket.
 *
 * Futtatás (dry-run alapból):
 *   npx tsx scripts/repair-skill-lost-attachments.ts
 *   npx tsx scripts/repair-skill-lost-attachments.ts --apply
 */
import { prisma } from '../src/lib/db'
import { services } from '../src/domain'
import { parseSkillContent, parseSkillRequires } from '../src/lib/skill/skill-content'
import { parseSkillAttachments } from '../src/lib/skill/skill-attachments'

const APPLY = process.argv.includes('--apply')

async function main() {
  const skills = await prisma.skill.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
  })

  let repaired = 0
  for (const skill of skills) {
    const active = skill.versions.find((v) => v.status === 'active')
    if (!active) continue
    if (parseSkillAttachments(active.attachments).length > 0) continue

    // A legutóbbi olyan verzió, aminek még voltak fájljai (a lista már desc).
    const donor = skill.versions.find((v) => parseSkillAttachments(v.attachments).length > 0)
    if (!donor) continue

    const attachments = parseSkillAttachments(donor.attachments)
    console.log(
      `• ${skill.name}: aktív v${active.version} 0 fájl ← v${donor.version} ${attachments.length} fájl ` +
        `(${attachments.map((a) => a.path).join(', ')})`,
    )
    if (!APPLY) continue

    // Jóváhagyó: a skill tenantjának egy aktív adminja (SoD: ember írja alá).
    const approver = await prisma.user.findFirst({
      where: {
        status: 'active',
        ...(skill.tenantId
          ? { tenantMemberships: { some: { tenantId: skill.tenantId, role: 'admin' } } }
          : { platformMemberships: { some: { status: 'active' } } }),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true },
    })
    if (!approver) {
      console.log('  ! nincs aktív admin a jóváhagyáshoz — kihagyva')
      continue
    }

    const actor = {
      actorId: approver.id,
      actorTenantId: skill.tenantId,
      isPlatformAdmin: skill.tenantId === null,
    }
    const proposed = await services.skills.proposeVersion({
      skillId: skill.id,
      content: parseSkillContent(active.content),
      requires: parseSkillRequires(active.requires),
      attachments,
      actor,
    })
    await services.skills.approveVersion({ versionId: proposed.versionId, actor })
    repaired++
    console.log(`  ✓ v${proposed.version} aktiválva (jóváhagyó: ${approver.email})`)
  }

  console.log(
    APPLY
      ? `\nKész: ${repaired} skill javítva.`
      : '\nDry-run — írás nem történt. Alkalmazás: --apply',
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
