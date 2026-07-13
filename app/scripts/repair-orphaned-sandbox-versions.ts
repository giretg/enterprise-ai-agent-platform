/**
 * Árva sandbox_app verziók törlése: DB sor létezik, de a GCS/stub artefakt hiányzik.
 * Futtatás: npx tsx scripts/repair-orphaned-sandbox-versions.ts [--app-id UUID] [--apply]
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

function parseArgs(argv: string[]) {
  let appId: string | undefined
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-id') appId = argv[++i]
    if (argv[i] === '--apply') apply = true
  }
  return { appId, apply }
}

async function main() {
  const { appId, apply } = parseArgs(process.argv.slice(2))
  const { prisma } = await import('../src/lib/db')
  const { GcsArtifactStore } = await import('../src/domain/sandbox/artifact-store')

  const bucket = process.env.SANDBOX_APP_BUCKET ?? 'platform-sandbox-apps-prod'
  const store = new GcsArtifactStore(bucket)

  const apps = await prisma.sandboxApp.findMany({
    where: appId ? { id: appId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { versions: { orderBy: { version: 'desc' } } },
  })

  if (apps.length === 0) {
    console.log('Nincs ilyen sandbox app.')
    await prisma.$disconnect()
    return
  }

  const orphaned: Array<{ appId: string; appName: string; versionId: string; version: number; artifactRef: string }> =
    []

  for (const app of apps) {
    for (const version of app.versions) {
      try {
        await store.get(version.artifactRef)
      } catch {
        orphaned.push({
          appId: app.id,
          appName: app.name,
          versionId: version.id,
          version: version.version,
          artifactRef: version.artifactRef,
        })
      }
    }
  }

  if (orphaned.length === 0) {
    console.log('Nincs árva verzió — minden artefakt elérhető.')
    await prisma.$disconnect()
    return
  }

  console.log(`Árva verziók (${orphaned.length}):`)
  for (const row of orphaned) {
    console.log(`  app=${row.appId.slice(0, 8)} v${row.version}  ${row.appName}`)
    console.log(`    ref=${row.artifactRef}`)
  }

  if (!apply) {
    console.log('\nDry-run. Törléshez: --apply')
    await prisma.$disconnect()
    return
  }

  for (const row of orphaned) {
    await prisma.sandboxAppVersion.delete({ where: { id: row.versionId } })
    console.log(`  törölve: v${row.version} (${row.versionId.slice(0, 8)})`)
  }

  const affectedAppIds = [...new Set(orphaned.map((o) => o.appId))]
  for (const id of affectedAppIds) {
    const app = await prisma.sandboxApp.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
    if (!app) continue
    const latest = app.versions[0]
    await prisma.sandboxApp.update({
      where: { id },
      data: {
        activeVersionId: latest?.id ?? null,
        status: latest?.status === 'active' ? 'active' : 'draft',
      },
    })
  }

  console.log('\nKész. Az agent újra hívhatja a sandbox_app.update_artifact-et.')
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('REPAIR HIBA:', e instanceof Error ? e.message : e)
  process.exit(1)
})
