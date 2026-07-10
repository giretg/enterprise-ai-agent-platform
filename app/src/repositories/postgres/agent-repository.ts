import type { Agent, Document, Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import { composeBehaviorProfile } from '@/lib/behavior-profile'
import { selfEvolutionProfileSchema } from '@/lib/self-evolution-profile'
import { assertTransition, isPhysicallyDeletable } from '@/lib/agent-lifecycle'
import type { AgentRepository, DocumentRepository } from '../interfaces'

function agentVisibilityWhere(id: string, tenantId?: string | null): Prisma.AgentWhereInput {
  return tenantId === undefined ? { id } : { id, tenantId }
}

function serviceAccountScopesForRole(role: Agent['role']): string[] {
  return role === 'orchestrator'
    ? ['ticket:create']
    : ['ticket:read', 'ticket:create', 'tool:invoke']
}

export class PostgresAgentRepository implements AgentRepository {
  async findMany(filter?: { tenantId?: string | null }): Promise<Agent[]> {
    return prisma.agent.findMany({
      where: filter?.tenantId !== undefined ? { tenantId: filter.tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findById(id: string, tenantId?: string | null): Promise<Agent | null> {
    return prisma.agent.findFirst({ where: agentVisibilityWhere(id, tenantId) })
  }

  async findByIdWithDetails(id: string, tenantId?: string | null) {
    const agent = await prisma.agent.findFirst({
      where: agentVisibilityWhere(id, tenantId),
      include: {
        memory: {
          include: {
            currentVersion: true,
            versions: { orderBy: { version: 'desc' }, take: 5 },
          },
        },
        agentResources: { include: { resource: true } },
        apiKeys: { where: { status: 'active' }, take: 1 },
        behaviorProfileRef: { select: { id: true, name: true, currentVersion: true } },
      },
    })

    if (!agent) return null

    // A reprodukálhatósághoz (§5.3): az aktuális agent-verzióhoz fagyasztott recipe.
    const currentAgentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
      include: { recipeVersion: { include: { recipe: true } } },
    })
    const recipeVersion = currentAgentVersion?.recipeVersion ?? null

    // §3.4: a megjelenítéshez a pinnelt profil-al-verzió TÖRZSE (a "központi rész"),
    // hogy az egyedi overlay-től elkülönítve látszódjon. A verziók append-only-k, így
    // a pinnelt verzió törzse determinisztikusan visszakérhető (drift-mentes).
    const pinnedProfileVersion = agent.currentBehaviorProfileId
      ? await prisma.behaviorProfileVersion.findFirst({
          where: {
            profileId: agent.currentBehaviorProfileId,
            version: agent.currentBehaviorProfileVersion,
          },
          select: { body: true },
        })
      : null

    return {
      agent,
      memoryContent: agent.memory.currentVersion?.content ?? null,
      memoryVersion: agent.memory.currentVersion?.version ?? null,
      recipe: recipeVersion
        ? {
            name: recipeVersion.recipe.name,
            ticketType: recipeVersion.recipe.ticketType,
            version: recipeVersion.version,
            status: recipeVersion.status,
          }
        : null,
      resources: agent.agentResources.map((ar) => ({
        id: ar.resource.id,
        name: ar.resource.name,
        type: ar.resource.type,
        scope: ar.resource.scope,
        version: ar.resource.version,
        accessMode: ar.accessMode,
      })),
      apiKeyPreview: agent.apiKeys[0] ? 'cp_sk_•••••••• (scoped)' : null,
      // §3.4 kaszkád: ha az agent megosztott viselkedés-profilra hivatkozik, felhozzuk
      // a profil aktuális al-verzióját, hogy a detail-oldal jelezni tudja, ha az agent
      // pinnelt verziója elavult, és felkínálja a befogadást (acceptBehaviorProfileUpdate).
      behaviorProfileLink: agent.behaviorProfileRef
        ? {
            id: agent.behaviorProfileRef.id,
            name: agent.behaviorProfileRef.name,
            currentVersion: agent.behaviorProfileRef.currentVersion,
            pinnedVersion: agent.currentBehaviorProfileVersion,
            pinnedBody: pinnedProfileVersion?.body ?? '',
          }
        : null,
    }
  }

  async findVersionSnapshot(agentId: string, version: number) {
    const agentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId, version } },
      include: {
        recipeVersion: { include: { recipe: true } },
        memoryVersion: true,
      },
    })
    if (!agentVersion) return null

    return {
      agentVersion: agentVersion.version,
      roleInstruction: agentVersion.roleInstructionSnapshot,
      behaviorProfile: agentVersion.behaviorProfileSnapshot,
      roleInstructionVersion: agentVersion.roleInstructionVersion,
      behaviorProfileVersion: agentVersion.behaviorProfileVersion,
      memoryVersion: agentVersion.memoryVersion?.version ?? null,
      model: agentVersion.modelConfigSnapshot,
      recipe: agentVersion.recipeVersion
        ? {
            name: agentVersion.recipeVersion.recipe.name,
            version: agentVersion.recipeVersion.version,
            status: agentVersion.recipeVersion.status,
          }
        : null,
    }
  }

  async create(input: {
    name: string
    roleInstruction: string
    behaviorProfile: string
    modelConfig: Agent['modelConfig']
    role?: Agent['role']
    selfEvolutionProfile?: Agent['selfEvolutionProfile']
    initialMemory?: string
    createdById: string
    tenantId?: string | null
    status?: Agent['status']
  }) {
    const memory = await prisma.memory.create({ data: {} })

    const memoryVersion = await prisma.memoryVersion.create({
      data: {
        memoryId: memory.id,
        version: 1,
        content: input.initialMemory ?? '',
        status: 'active',
        source: 'createAgent',
        approvedById: input.createdById,
      },
    })

    await prisma.memory.update({
      where: { id: memory.id },
      data: { currentVersionId: memoryVersion.id },
    })

    const agentRole = input.role ?? 'worker'
    const selfEvolutionProfile = input.selfEvolutionProfile
      ? (selfEvolutionProfileSchema.parse(input.selfEvolutionProfile) as Prisma.InputJsonValue)
      : undefined

    const status = input.status ?? 'active'
    const agent = await prisma.agent.create({
      data: {
        name: input.name,
        tenantId: input.tenantId ?? null,
        roleInstruction: input.roleInstruction,
        behaviorProfile: input.behaviorProfile,
        // Létrehozáskor nincs megosztott profil — a megadott "hogyan" szöveg teljes
        // egészében az agent egyedi overlay-e (§3.4). Az effektív = csak az overlay.
        behaviorProfileOverlay: input.behaviorProfile,
        modelConfig: input.modelConfig as Prisma.InputJsonValue,
        status,
        role: agentRole,
        selfEvolutionProfile,
        currentVersion: 1,
        currentRoleInstructionVersion: 1,
        currentBehaviorProfileVersion: 1,
        memoryId: memory.id,
      },
    })

    // §4/I2: a `draft` agentnek MÉG nincs reprodukálhatósági snapshotja — azt az
    // `activate` fagyasztja be. Aktívan létrehozott (walking-skeleton) agentnek
    // viszont azonnal kell egy v1 snapshot.
    if (status !== 'draft') {
      await prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: 1,
          roleInstructionSnapshot: input.roleInstruction,
          behaviorProfileSnapshot: input.behaviorProfile,
          roleInstructionVersion: 1,
          behaviorProfileVersion: 1,
          modelConfigSnapshot: input.modelConfig as Prisma.InputJsonValue,
          memoryVersionId: memoryVersion.id,
          selfEvolutionSnapshot: selfEvolutionProfile,
        },
      })
    }

    const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
    await prisma.agentApiKey.create({
      data: {
        agentId: agent.id,
        keyHash: await bcrypt.hash(rawKey, 10),
        scopes: serviceAccountScopesForRole(agentRole),
        status: 'active',
      },
    })

    const board = await prisma.connector.findFirst({
      where: { type: 'board', name: 'Control Plane Board' },
    })
    if (board) {
      await prisma.agentConnector.upsert({
        where: { agentId_connectorId: { agentId: agent.id, connectorId: board.id } },
        create: { agentId: agent.id, connectorId: board.id, accessMode: 'write' },
        update: { accessMode: 'write' },
      })
    }

    if (agentRole === 'worker') {
      for (const toolName of ['ticket_create', 'agent_ask', 'agent_resolve', 'agent_catalog', 'user_directory']) {
        await prisma.capability.upsert({
          where: { agentId_toolName: { agentId: agent.id, toolName } },
          create: { agentId: agent.id, toolName, allowed: true },
          update: { allowed: true },
        })
      }
    }

    await ensureAgentKnowledgeBase(agent)

    return { agent, apiKey: rawKey }
  }

  async updateInstruction(input: {
    agentId: string
    roleInstruction?: string
    behaviorProfile?: string
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    const nextRole = input.roleInstruction ?? agent.roleInstruction
    const nextBehavior = input.behaviorProfile ?? agent.behaviorProfile
    const roleChanged = nextRole !== agent.roleInstruction
    const behaviorChanged = nextBehavior !== agent.behaviorProfile

    if (!roleChanged && !behaviorChanged) {
      throw new Error('No instruction change provided')
    }

    // A reprodukálhatósághoz az új snapshot örökli az aktuális agent-verzió
    // memória- és recipe-kötését (§5.3).
    const currentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })
    if (!currentVersion) throw new Error('Current agent version snapshot missing')

    const nextRoleVersion = agent.currentRoleInstructionVersion + (roleChanged ? 1 : 0)
    const nextBehaviorVersion = agent.currentBehaviorProfileVersion + (behaviorChanged ? 1 : 0)
    const nextAgentVersion = agent.currentVersion + 1

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: nextRole,
          behaviorProfileSnapshot: nextBehavior,
          roleInstructionVersion: nextRoleVersion,
          behaviorProfileVersion: nextBehaviorVersion,
          modelConfigSnapshot: currentVersion.modelConfigSnapshot as Prisma.InputJsonValue,
          memoryVersionId: currentVersion.memoryVersionId,
          recipeVersionId: currentVersion.recipeVersionId,
          selfEvolutionSnapshot: (agent.selfEvolutionProfile ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          roleInstruction: nextRole,
          behaviorProfile: nextBehavior,
          currentVersion: nextAgentVersion,
          currentRoleInstructionVersion: nextRoleVersion,
          currentBehaviorProfileVersion: nextBehaviorVersion,
        },
      }),
    ])

    return {
      agentVersion: nextAgentVersion,
      roleInstructionVersion: nextRoleVersion,
      behaviorProfileVersion: nextBehaviorVersion,
      roleChanged,
      behaviorChanged,
    }
  }

  async updateModelConfig(input: { agentId: string; modelConfig: Agent['modelConfig'] }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    // Új snapshot örökli az aktuális szerep/viselkedés al-verziókat, memória- és
    // recipe-kötést; csak a modell-konfig változik (reprodukálhatóság).
    const currentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })
    if (!currentVersion) throw new Error('Current agent version snapshot missing')

    const nextAgentVersion = agent.currentVersion + 1

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: agent.roleInstruction,
          behaviorProfileSnapshot: agent.behaviorProfile,
          roleInstructionVersion: agent.currentRoleInstructionVersion,
          behaviorProfileVersion: agent.currentBehaviorProfileVersion,
          modelConfigSnapshot: input.modelConfig as Prisma.InputJsonValue,
          memoryVersionId: currentVersion.memoryVersionId,
          recipeVersionId: currentVersion.recipeVersionId,
          selfEvolutionSnapshot: (agent.selfEvolutionProfile ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          modelConfig: input.modelConfig as Prisma.InputJsonValue,
          currentVersion: nextAgentVersion,
        },
      }),
    ])

    return { agentVersion: nextAgentVersion }
  }

  /**
   * Sensitivity router per-agent felmentés (§4.7.2). Nem emel agent-verziót: a
   * prompt-reprodukálhatóságot nem érinti, csak azt, hová mehet a hívás.
   */
  async updateSensitivityPolicy(input: {
    agentId: string
    allowSensitiveExternalModel: boolean
  }): Promise<{ allowSensitiveExternalModel: boolean }> {
    const updated = await prisma.agent.update({
      where: { id: input.agentId },
      data: { allowSensitiveExternalModel: input.allowSensitiveExternalModel },
      select: { allowSensitiveExternalModel: true },
    })
    return updated
  }

  async updatePersona(input: {
    agentId: string
    personaNickname?: string | null
    personaGreeting?: string | null
    personaTrait?: string | null
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    const normalize = (value: string | null | undefined) => {
      if (value === undefined) return undefined
      if (value === null) return null
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : null
    }

    return prisma.agent.update({
      where: { id: input.agentId },
      data: {
        ...(input.personaNickname !== undefined
          ? { personaNickname: normalize(input.personaNickname) }
          : {}),
        ...(input.personaGreeting !== undefined
          ? { personaGreeting: normalize(input.personaGreeting) }
          : {}),
        ...(input.personaTrait !== undefined
          ? { personaTrait: normalize(input.personaTrait) }
          : {}),
      },
    })
  }

  async updateAvatar(input: { agentId: string; avatarUrl: string | null }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    return prisma.agent.update({
      where: { id: input.agentId },
      data: { avatarUrl: input.avatarUrl },
    })
  }

  async updateSelfEvolutionProfile(input: {
    agentId: string
    profile: Agent['selfEvolutionProfile']
  }) {
    const parsed = selfEvolutionProfileSchema.parse(input.profile)
    return prisma.agent.update({
      where: { id: input.agentId },
      data: { selfEvolutionProfile: parsed as Prisma.InputJsonValue },
    })
  }

  async rotateApiKey(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')

    const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
    const scopes = serviceAccountScopesForRole(agent.role)
    const now = new Date()

    const created = await prisma.$transaction(async (tx) => {
      await tx.agentApiKey.updateMany({
        where: { agentId, status: 'active' },
        data: { status: 'revoked', rotatedAt: now },
      })
      return tx.agentApiKey.create({
        data: {
          agentId,
          keyHash: await bcrypt.hash(rawKey, 10),
          scopes,
          status: 'active',
          rotatedAt: now,
        },
      })
    })

    return { keyId: created.id, apiKey: rawKey, scopes }
  }

  async issueEphemeralKey(agentId: string, opts?: { ttlMs?: number }) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')

    const rawKey = `cp_sk_${randomBytes(16).toString('hex')}`
    const scopes = serviceAccountScopesForRole(agent.role)
    const ttlMs = opts?.ttlMs
    const expiresAt =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
        ? new Date(Date.now() + ttlMs)
        : null

    const created = await prisma.agentApiKey.create({
      data: {
        agentId,
        keyHash: await bcrypt.hash(rawKey, 10),
        scopes,
        status: 'active',
        expiresAt,
      },
    })

    return { id: created.id, rawKey, scopes }
  }

  async revokeKey(keyId: string) {
    await prisma.agentApiKey.updateMany({
      where: { id: keyId, status: 'active' },
      data: { status: 'revoked', rotatedAt: new Date() },
    })
  }

  async revokeApiKey(keyId: string) {
    const existing = await prisma.agentApiKey.findUnique({ where: { id: keyId } })
    if (!existing) throw new Error('Agent API key not found')

    const revoked = await prisma.agentApiKey.update({
      where: { id: keyId },
      data: { status: 'revoked', rotatedAt: new Date() },
    })

    return { keyId: revoked.id, agentId: revoked.agentId }
  }

  /**
   * Megosztott viselkedés-profil frissítésének BEFOGADÁSA (§3.4 kaszkád, I7).
   * Explicit admin-művelet: a hivatkozó agent élő viselkedését a profil adott
   * al-verziójára állítja, ÉS új `agent_versions` snapshotot fagyaszt — így a
   * megosztott profil módosítása sem okoz csendes driftet a hivatkozókon.
   */
  async acceptBehaviorProfileUpdate(input: {
    agentId: string
    profileId: string
    profileVersion: number
    profileBody: string
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    const currentVersion = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })
    if (!currentVersion) throw new Error('Current agent version snapshot missing')

    const nextAgentVersion = agent.currentVersion + 1
    // Az egyedi overlay megmarad — az effektív a friss profil-törzs + overlay (§3.4).
    const effective = composeBehaviorProfile(input.profileBody, agent.behaviorProfileOverlay)

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: agent.roleInstruction,
          behaviorProfileSnapshot: effective,
          roleInstructionVersion: agent.currentRoleInstructionVersion,
          behaviorProfileVersion: input.profileVersion,
          modelConfigSnapshot: currentVersion.modelConfigSnapshot as Prisma.InputJsonValue,
          memoryVersionId: currentVersion.memoryVersionId,
          recipeVersionId: currentVersion.recipeVersionId,
          selfEvolutionSnapshot: (agent.selfEvolutionProfile ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          behaviorProfile: effective,
          currentBehaviorProfileId: input.profileId,
          currentBehaviorProfileVersion: input.profileVersion,
          currentVersion: nextAgentVersion,
        },
      }),
    ])

    return { agentVersion: nextAgentVersion, behaviorProfileVersion: input.profileVersion }
  }

  /**
   * A ténylegesen használt viselkedés-profil beállítása (§3.4): egy megosztott
   * profil (vagy semmi) kiválasztása + az agent egyedi overlay-e. A kettőből
   * komponálja az effektív "hogyan" szöveget, pinneli a profil aktuális
   * al-verzióját, és — aktív agentnél — új reprodukálhatósági snapshotot fagyaszt.
   * Draft agentnél (nincs snapshot) csak az élő mezőket állítja.
   */
  async setBehaviorProfile(input: {
    agentId: string
    profileId: string | null
    profileVersion: number | null
    profileBody: string | null
    overlay: string | null
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } })
    if (!agent) throw new Error('Agent not found')

    const overlay = input.overlay?.trim() ? input.overlay.trim() : null
    const effective = composeBehaviorProfile(input.profileBody, overlay)
    if (effective.length === 0) {
      throw new Error('A munkastílus nem lehet üres — adj meg profilt vagy egyedi szöveget')
    }

    // No-op védelem: ha se a profil-kötés, se az overlay, se az effektív szöveg nem
    // változott, ne fagyasszunk felesleges új verziót.
    const unchanged =
      effective === agent.behaviorProfile &&
      (input.profileId ?? null) === (agent.currentBehaviorProfileId ?? null) &&
      (overlay ?? '') === (agent.behaviorProfileOverlay ?? '')
    if (unchanged) {
      return {
        agentVersion: agent.currentVersion,
        behaviorProfileVersion: agent.currentBehaviorProfileVersion,
      }
    }

    // A megosztott profilhoz kötött agentnél a viselkedés-al-verzió a profil pinnelt
    // verziója; egyedi (profil nélküli) esetben az agent saját, növekvő al-verziója.
    const nextBehaviorVersion =
      input.profileId != null
        ? (input.profileVersion ?? agent.currentBehaviorProfileVersion)
        : agent.currentBehaviorProfileVersion + 1

    const currentSnapshot = await prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version: agent.currentVersion } },
    })

    // Draft agent: még nincs reprodukálhatósági snapshot (§4/I2) — csak az élő mezők.
    if (!currentSnapshot) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          behaviorProfile: effective,
          behaviorProfileOverlay: overlay,
          currentBehaviorProfileId: input.profileId,
          currentBehaviorProfileVersion: nextBehaviorVersion,
        },
      })
      return { agentVersion: agent.currentVersion, behaviorProfileVersion: nextBehaviorVersion }
    }

    const nextAgentVersion = agent.currentVersion + 1

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version: nextAgentVersion,
          roleInstructionSnapshot: agent.roleInstruction,
          behaviorProfileSnapshot: effective,
          roleInstructionVersion: agent.currentRoleInstructionVersion,
          behaviorProfileVersion: nextBehaviorVersion,
          modelConfigSnapshot: currentSnapshot.modelConfigSnapshot as Prisma.InputJsonValue,
          memoryVersionId: currentSnapshot.memoryVersionId,
          recipeVersionId: currentSnapshot.recipeVersionId,
          selfEvolutionSnapshot: (agent.selfEvolutionProfile ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          behaviorProfile: effective,
          behaviorProfileOverlay: overlay,
          currentBehaviorProfileId: input.profileId,
          currentBehaviorProfileVersion: nextBehaviorVersion,
          currentVersion: nextAgentVersion,
        },
      }),
    ])

    return { agentVersion: nextAgentVersion, behaviorProfileVersion: nextBehaviorVersion }
  }

  /**
   * draft → active (§4): befagyasztja az első reprodukálhatósági snapshotot
   * (szerep + viselkedés + modell + memória + önfejlesztési profil), és aktívvá
   * teszi az agentet. Csak `draft`-ból hívható (állapotgép-invariáns).
   */
  async activate(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'active')

    const memory = await prisma.memory.findUnique({ where: { id: agent.memoryId } })
    if (!memory?.currentVersionId) throw new Error('Agent memory version missing')

    const existing = await prisma.agentVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { version: 'desc' },
    })
    const version = existing ? existing.version + 1 : agent.currentVersion

    await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: agent.id,
          version,
          roleInstructionSnapshot: agent.roleInstruction,
          behaviorProfileSnapshot: agent.behaviorProfile,
          roleInstructionVersion: agent.currentRoleInstructionVersion,
          behaviorProfileVersion: agent.currentBehaviorProfileVersion,
          modelConfigSnapshot: agent.modelConfig as Prisma.InputJsonValue,
          memoryVersionId: memory.currentVersionId,
          selfEvolutionSnapshot: (agent.selfEvolutionProfile ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: { status: 'active', currentVersion: version },
      }),
    ])

    return { agent: await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } }), agentVersion: version }
  }

  /** active → suspended (§4): új dispatch tiltott, a meglévő futások kifutnak. */
  async suspend(agentId: string, reason: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'suspended')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'suspended', suspendedReason: reason },
    })
  }

  /** suspended → active (§4): nincs új snapshot, ha a konfiguráció nem változott. */
  async resume(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'active')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'active', suspendedReason: null },
    })
  }

  /** active|suspended → retired (§4): terminális; a verziólánc megőrződik. */
  async retire(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'retired')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'retired', retiredAt: new Date() },
    })
  }

  async delete(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')

    // I3: aktivált/felfüggesztett/nyugdíjazott agent fizikailag NEM törölhető —
    // a múltbeli munkák attribútálhatósága megőrzendő; csak `retire` engedett.
    if (!isPhysicallyDeletable(agent.status)) {
      throw new Error(
        `Aktivált agent nem törölhető (status=${agent.status}); csak nyugdíjazható (retire).`,
      )
    }

    const memoryId = agent.memoryId

    await prisma.$transaction(async (tx) => {
      await tx.ticket.updateMany({
        where: { agentId },
        data: { agentId: null },
      })
      await tx.ticket.updateMany({
        where: { assigneeType: 'agent', assigneeId: agentId },
        data: { assigneeType: null, assigneeId: null },
      })
      await tx.toolCall.deleteMany({ where: { agentId } })
      await tx.modelCall.deleteMany({ where: { agentId } })
      await tx.agent.delete({ where: { id: agentId } })
      await tx.memory.update({
        where: { id: memoryId },
        data: { currentVersionId: null },
      })
      await tx.memoryVersion.deleteMany({ where: { memoryId } })
      await tx.memory.delete({ where: { id: memoryId } })
    })

    return { id: agent.id, name: agent.name }
  }

  async authenticateApiKey(rawKey: string) {
    if (!rawKey.startsWith('cp_sk_')) return null

    const now = new Date()
    const activeKeys = await prisma.agentApiKey.findMany({
      where: {
        status: 'active',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { agentId: true, keyHash: true, scopes: true, id: true },
    })

    for (const key of activeKeys) {
      if (await bcrypt.compare(rawKey, key.keyHash)) {
        await prisma.agentApiKey.update({
          where: { id: key.id },
          data: { lastUsedAt: new Date() },
        })
        return {
          agentId: key.agentId,
          scopes: key.scopes as string[],
        }
      }
    }

    return null
  }
}

export class PostgresDocumentRepository implements DocumentRepository {
  async findById(id: string): Promise<Document | null> {
    return prisma.document.findUnique({ where: { id } })
  }

  async findByConnectorId(connectorId: string): Promise<Document[]> {
    return prisma.document.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(
    data: Omit<
      Document,
      'id' | 'createdAt' | 'mimeType' | 'contentHash' | 'processingMode' | 'metadata'
    > &
      Partial<Pick<Document, 'mimeType' | 'contentHash' | 'processingMode' | 'metadata'>>,
  ): Promise<Document> {
    const { metadata, ...rest } = data
    return prisma.document.create({
      data: {
        ...rest,
        ...(metadata !== undefined ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
    })
  }

  async update(
    id: string,
    data: Partial<
      Pick<Document, 'status' | 'extractedText' | 'connectorId' | 'processingMode'>
    >,
  ): Promise<Document> {
    return prisma.document.update({ where: { id }, data })
  }

  async delete(id: string): Promise<void> {
    await prisma.document.delete({ where: { id } })
  }
}
