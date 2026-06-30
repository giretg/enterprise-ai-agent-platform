import { prisma } from '@/lib/db'

/**
 * Megosztott viselkedés-profil ("hogyan") repository — Feature-spec §3.4.
 *
 * Kulcs-invariáns (I7, N-AR-3): a profil új al-verzióra promótálása NEM
 * változtatja meg automatikusan a hivatkozó agentek élő viselkedését. A frissítés
 * befogadása külön, explicit admin-művelet (`acceptBehaviorProfileUpdate` az
 * agent-repositoryban), amely új `agent_versions` snapshotot ír.
 */
export class PostgresBehaviorProfileRepository {
  async create(input: { name: string; body: string; tenantId?: string | null; approvedById: string }) {
    return prisma.behaviorProfile.create({
      data: {
        name: input.name,
        tenantId: input.tenantId ?? null,
        currentVersion: 1,
        versions: {
          create: { version: 1, body: input.body, approvedById: input.approvedById },
        },
      },
      include: { versions: true },
    })
  }

  /** Új al-verziót fagyaszt; NEM frissíti a hivatkozó agenteket (I7). */
  async update(input: { profileId: string; body: string; approvedById: string }) {
    const profile = await prisma.behaviorProfile.findUnique({ where: { id: input.profileId } })
    if (!profile) throw new Error('Behavior profile not found')

    const nextVersion = profile.currentVersion + 1
    const [, version] = await prisma.$transaction([
      prisma.behaviorProfile.update({
        where: { id: profile.id },
        data: { currentVersion: nextVersion },
      }),
      prisma.behaviorProfileVersion.create({
        data: {
          profileId: profile.id,
          version: nextVersion,
          body: input.body,
          approvedById: input.approvedById,
        },
      }),
    ])

    return { profileId: profile.id, version: version.version }
  }

  async findMany(tenantId?: string | null) {
    const profiles = await prisma.behaviorProfile.findMany({
      where: tenantId === undefined ? {} : { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { agents: true } } },
    })
    return profiles.map((p) => ({
      id: p.id,
      name: p.name,
      currentVersion: p.currentVersion,
      referrerCount: p._count.agents,
      createdAt: p.createdAt,
    }))
  }

  async findByIdWithVersions(profileId: string) {
    return prisma.behaviorProfile.findUnique({
      where: { id: profileId },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async getVersionBody(profileId: string, version: number): Promise<string | null> {
    const row = await prisma.behaviorProfileVersion.findUnique({
      where: { profileId_version: { profileId, version } },
      select: { body: true },
    })
    return row?.body ?? null
  }

  /** A profilt hivatkozó agentek és a rájuk pinnelt al-verzió (kaszkád-felderítés). */
  async listReferrers(profileId: string) {
    const agents = await prisma.agent.findMany({
      where: { currentBehaviorProfileId: profileId },
      select: { id: true, name: true, currentBehaviorProfileVersion: true, status: true },
    })
    return agents.map((a) => ({
      id: a.id,
      name: a.name,
      pinnedVersion: a.currentBehaviorProfileVersion,
      status: a.status,
    }))
  }
}
