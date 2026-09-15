'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok, type ActionResult } from '@/lib/result'
import { logger } from '@/lib/observability/logger'
import {
  computeAgentDiagnostics,
  DRIVE_WRITE_TOOLS,
  GMAIL_WRITE_TOOLS,
  type DiagnosticCheck,
} from '@/domain/agent-diagnostics/agent-diagnostics'
import {
  DIAGNOSTICS_PROBE_MARKER,
  probeResultToCheck,
  sanitizeProbeError,
  withProbeTimeout,
  type ProbeResult,
} from '@/domain/agent-diagnostics/agent-probes'
import { gmailToolAllowedByScopes } from '@/domain/connector-grant/gmail-scopes'
import { driveToolAllowedByScopes } from '@/domain/connector-grant/google-drive-scopes'
import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import { HttpSandboxConnectionTester } from '@/domain/provisioning/sandbox-connection-tester'
import { normalizeConnectorConfig } from '@/domain/provisioning/connector-config'

const inputSchema = z.object({
  agentId: z.string().uuid(),
  /** Élő read-only próba (olvasás). Nincs mellékhatása. */
  includeLive: z.boolean().default(true),
  /** Opt-in próba-írás: piszkozat/mappa létrehozás + azonnali törlés. Küldés soha. */
  includeWriteProbe: z.boolean().default(false),
})

export type AgentDiagnosticsResult = {
  static: DiagnosticCheck[]
  live: DiagnosticCheck[]
}

/**
 * Agent-teszt egy gombnyomásra (admin-only).
 *
 * Statikus réteg: jog → kötés, grant-scope íráslefedettség, skill-readiness —
 * írás és hálózat nélkül. Élő réteg: read-only próba az admin SAJÁT fiókjával
 * (az ő grantje oldódik fel, nem az agenté), opt-in próba-írással, ami mindig
 * létrehoz + azonnal töröl. Titok soha nem kerül a válaszba.
 */
export async function runAgentDiagnostics(input: {
  agentId: string
  includeLive?: boolean
  includeWriteProbe?: boolean
}): Promise<ActionResult<AgentDiagnosticsResult>> {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = inputSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, ctx.activeTenantId)
    if (!agent) return fail('Agent not found')

    const [capabilities, connectors, skillsWithReadiness, myGrants] = await Promise.all([
      repositories.toolBroker.findCapabilitiesForAgent(parsed.agentId),
      repositories.toolBroker.findConnectorsForAgent(parsed.agentId),
      services.skills.listAgentSkillsWithReadiness(parsed.agentId),
      services.connectorGrants.listForUser(ctx.user.id, ctx.activeTenantId),
    ])

    const allowedTools = capabilities.filter((c) => c.allowed).map((c) => c.toolName)
    const boundConnectorTypes = [...new Set(connectors.map((c) => c.connector.type))]

    const activeGrants = myGrants.filter(
      (g) => g.status === 'active' && g.connector.lifecycleState === 'active',
    )
    const grantByConnectorId = new Map(activeGrants.map((g) => [g.connectorId, g]))

    // Íráslefedettség a grant scope alapján — csak akkor dönthető el, ha az
    // adminnak van aktív grantje az adott connectorra.
    let gmailSendCovered: boolean | null = null
    let driveWriteCovered: boolean | null = null
    let driveWriteIsSelectedOnly = false
    const needsGmailWrite = allowedTools.some((t) =>
      (GMAIL_WRITE_TOOLS as readonly string[]).includes(t),
    )
    const needsDriveWrite = allowedTools.some((t) =>
      (DRIVE_WRITE_TOOLS as readonly string[]).includes(t),
    )
    for (const binding of connectors) {
      const grant = grantByConnectorId.get(binding.connector.id)
      if (!grant) continue
      if (binding.connector.type === 'gmail' && needsGmailWrite && gmailSendCovered === null) {
        gmailSendCovered = gmailToolAllowedByScopes({
          tool: 'gmail_create_draft',
          scopes: grant.scopes,
        })
      }
      if (
        binding.connector.type === 'google_drive' &&
        needsDriveWrite &&
        driveWriteCovered === null
      ) {
        driveWriteCovered = driveToolAllowedByScopes({
          tool: 'google_drive_create_folder',
          scopes: grant.scopes,
        })
        driveWriteIsSelectedOnly = driveWriteCovered
      }
    }

    const staticChecks = computeAgentDiagnostics({
      allowedTools,
      boundConnectorTypes,
      gmailSendCovered,
      driveWriteCovered,
      driveWriteIsSelectedOnly,
      skills: skillsWithReadiness
        .filter((s) => s.enabled)
        .map((s) => ({
          name: s.displayName?.trim() || s.name,
          color: s.readiness.color,
          enabled: s.enabled,
        })),
      isDraft: agent.status === 'draft',
    })

    // Grant-hiány: a bekötött user-delegált connectorhoz az adminnak sincs fiókja —
    // az élő próba nála sem futna, és az agent sem tudna a nevében dolgozni.
    const live: DiagnosticCheck[] = []
    for (const binding of connectors) {
      if (binding.connector.authMode !== 'user_delegated') continue
      if (binding.connector.lifecycleState !== 'active') continue
      if (!grantByConnectorId.has(binding.connector.id)) {
        live.push(
          probeResultToCheck({
            id: `grant:${binding.connector.id}`,
            label: `${binding.connector.name}: nincs összekötött fiók`,
            outcome: 'fail',
            reason: 'no_grant',
            fixSection: 'kapcsolatok',
            fixHint: 'A Kapcsolatok résznél kösd össze a fiókot.',
          }),
        )
      }
    }

    if (parsed.includeLive) {
      const probeResults = await Promise.allSettled(
        connectors.map((binding) =>
          probeConnector({
            connectorId: binding.connector.id,
            connectorType: binding.connector.type,
            connectorName: binding.connector.name,
            connectorConfig: binding.connector.config,
            secretAlias:
              binding.agentSecretAlias ?? (binding.connector as { secretAlias?: string }).secretAlias ?? null,
            userId: ctx.user.id,
            tenantId: ctx.activeTenantId,
            includeWriteProbe: parsed.includeWriteProbe,
          }),
        ),
      )
      for (const settled of probeResults) {
        if (settled.status === 'fulfilled' && settled.value) live.push(probeResultToCheck(settled.value))
      }
    }

    logger.info({
      event: 'agent_diagnostics.run',
      agentId: parsed.agentId,
      tenantId: ctx.activeTenantId,
      userId: ctx.user.id,
      staticCount: staticChecks.length,
      liveCount: live.length,
      includeWriteProbe: parsed.includeWriteProbe,
    })

    return ok({ static: staticChecks, live })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to run agent diagnostics')
  }
}

async function probeConnector(params: {
  connectorId: string
  connectorType: string
  connectorName: string
  connectorConfig: unknown
  secretAlias: string | null
  userId: string
  tenantId: string | null
  includeWriteProbe: boolean
}): Promise<ProbeResult | null> {
  const base = { fixSection: 'kapcsolatok' as const, fixHint: 'A Kapcsolatok résznél ellenőrizd.' }
  try {
    if (params.connectorType === 'gmail') {
      return await probeGmail(params, base)
    }
    if (params.connectorType === 'google_drive') {
      return await probeDrive(params, base)
    }
    if (params.connectorType === 'http_api') {
      return await probeHttp(params, base)
    }
    // Jövőbeli/ismeretlen típus: nem bukik, csak jelzi, hogy kézi ellenőrzés kell.
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: automatikus próba nincs`,
      outcome: 'unknown',
      reason: 'not_testable',
      ...base,
    }
  } catch (e) {
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: élő próba sikertelen`,
      outcome: 'fail',
      reason: sanitizeProbeError(e),
      ...base,
      fixHint:
        sanitizeProbeError(e) === 'auth_failed'
          ? 'Kösd össze újra a fiókot a Kapcsolatok résznél.'
          : base.fixHint,
    }
  }
}

async function resolveUserToken(connectorId: string, userId: string) {
  const grant = await prisma.connectorGrant.findFirst({
    where: { connectorId, userId, status: 'active' },
    include: { connector: true },
    orderBy: { grantedAt: 'desc' },
  })
  if (!grant) throw new Error('no_grant')
  const accessToken = await services.connectorGrants.resolveAccessToken({
    connector: grant.connector,
    grantId: grant.id,
    tokenRef: grant.tokenRef,
    actingUserId: userId,
    tenantId: grant.tenantId,
  })
  return accessToken
}

async function probeGmail(
  params: { connectorId: string; connectorName: string; userId: string; includeWriteProbe: boolean },
  base: { fixSection: 'kapcsolatok'; fixHint: string },
): Promise<ProbeResult> {
  const token = await withProbeTimeout(resolveUserToken(params.connectorId, params.userId))
  const gmail = new GmailApiClient(token)
  await withProbeTimeout(gmail.search({ query: '', maxResults: 1 }))

  if (params.includeWriteProbe) {
    // Próba-írás: piszkozat + AZONNALI törlés. Küldés soha.
    const marker = `${DIAGNOSTICS_PROBE_MARKER} Agent-teszt ${new Date().toISOString().slice(0, 10)}`
    const draft = await withProbeTimeout(
      gmail.createDraft({ subject: marker, body: 'Automatikus agent-diagnosztika, azonnal törölve.' }),
    )
    try {
      await withProbeTimeout(gmail.deleteDraft({ draftId: draft.draftId }))
    } catch {
      // A piszkozat megmaradhat — a felhasználó egyértelmű név alapján törölheti.
    }
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: olvasás + próba-írás OK`,
      outcome: 'ok',
      reason: 'write_probe_ok',
      ...base,
    }
  }
  return {
    id: `live:${params.connectorId}`,
    label: `${params.connectorName}: olvasás OK`,
    outcome: 'ok',
    reason: 'reachable',
    ...base,
  }
}

async function probeDrive(
  params: { connectorId: string; connectorName: string; userId: string; includeWriteProbe: boolean },
  base: { fixSection: 'kapcsolatok'; fixHint: string },
): Promise<ProbeResult> {
  const token = await withProbeTimeout(resolveUserToken(params.connectorId, params.userId))
  const drive = new GoogleDriveApiClient(token)
  await withProbeTimeout(drive.search({ pageSize: 1 }))

  if (params.includeWriteProbe) {
    const name = `${DIAGNOSTICS_PROBE_MARKER} Agent-teszt ${new Date().toISOString().slice(0, 10)}`
    const created = await withProbeTimeout(drive.createFolder({ name }))
    try {
      await withProbeTimeout(drive.trashFile({ fileId: created.file.id }))
    } catch {
      // A mappa megmaradhat — a név alapján egyértelműen törölhető.
    }
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: olvasás + próba-írás OK`,
      outcome: 'ok',
      reason: 'write_probe_ok',
      ...base,
    }
  }
  return {
    id: `live:${params.connectorId}`,
    label: `${params.connectorName}: olvasás OK`,
    outcome: 'ok',
    reason: 'reachable',
    ...base,
  }
}

async function probeHttp(
  params: {
    connectorId: string
    connectorName: string
    connectorConfig: unknown
    secretAlias: string | null
    tenantId: string | null
  },
  base: { fixSection: 'kapcsolatok'; fixHint: string },
): Promise<ProbeResult> {
  // Token nélküli read-only próba a meglévő sandbox-testerrel (egress + SSRF-őr).
  let config
  try {
    config = normalizeConnectorConfig(params.connectorConfig)
  } catch {
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: automatikus próba nincs`,
      outcome: 'unknown',
      reason: 'not_testable',
      ...base,
    }
  }
  const tester = new HttpSandboxConnectionTester({
    // Ugyanaz a deny-by-default allowlist, mint a provisioning sandbox-tesztben:
    // env-lista + az admin által bővített platform-hostok.
    resolveEgressAllowlist: async (tenantId) => {
      const envList = (process.env.PROVISIONING_EGRESS_ALLOWLIST ?? '')
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
      const persisted = await services.platformSettings.getEgressAllowlist(tenantId)
      return [...new Set([...envList, ...persisted])]
    },
    resolveSandboxToken: async () => null,
  })
  const result = await withProbeTimeout(
    tester.test({ config, secretAlias: params.secretAlias, tenantId: params.tenantId }),
  )
  if (result.ok) {
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: elérhető`,
      outcome: 'ok',
      reason: result.detail === 'reachable_auth_required' ? 'reachable_auth_required' : 'reachable',
      ...base,
    }
  }
  if (result.detail === 'egress_not_allowlisted' || result.detail === 'blocked_by_validation') {
    return {
      id: `live:${params.connectorId}`,
      label: `${params.connectorName}: tiltólistán kívüli cél`,
      outcome: 'fail',
      reason: 'request_failed',
      ...base,
      fixHint: 'Ellenőrizd a connector célcímét és a tenant egress-engedélyeket.',
    }
  }
  return {
    id: `live:${params.connectorId}`,
    label: `${params.connectorName}: élő próba sikertelen`,
    outcome: 'fail',
    reason: 'request_failed',
    ...base,
  }
}
