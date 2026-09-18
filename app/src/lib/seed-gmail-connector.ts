import type { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import { BUILTIN_CONNECTOR_TEMPLATES } from '@/domain/connector-template/builtin-templates'
import { materializeGmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import { upsertConnectorByTypeName } from '@/lib/connector-upsert'

type ConnectorDb = Pick<PrismaClient, 'connector' | 'connectorDraft'>

function sha256Hex(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

/**
 * Aktív Gmail connectorhoz provisioning draft sor — különben nem jelenik meg a
 * provisioning UI „Aktivált kapcsolatok” listájában (csak connector_drafts-ból listáz).
 */
export async function ensureGmailProvisioningDraft(
  db: ConnectorDb,
  params: { tenantId: string; connectorId: string; templateKey: string; templateDescriptor: unknown },
) {
  const sourceHash = sha256Hex(JSON.stringify(params.templateDescriptor))
  const validationResult = {
    status: 'passed',
    checks: {
      egressAllowlist: 'passed',
      scopeMinimization: 'passed',
      forbiddenPatterns: 'passed',
      secretInline: 'passed',
      writeToolsFlagged: 'passed',
      oauthCompleteness: 'passed',
    },
    warnings: ['Seed/backfill — provisioning draft a meglévő aktív Gmailhez'],
    errors: [],
    unknownHosts: [],
  } satisfies Prisma.InputJsonObject

  return db.connectorDraft.upsert({
    where: { connectorId: params.connectorId },
    create: {
      tenantId: params.tenantId,
      connectorId: params.connectorId,
      sourceType: 'template',
      sourceRef: `${params.templateKey}@1`,
      sourceHash,
      reviewStatus: 'approved',
      sandboxTestOk: true,
      validationResult,
    },
    update: {
      reviewStatus: 'approved',
      sandboxTestOk: true,
      validationResult,
    },
  })
}

/**
 * Demo/dev seed: tenant-scope Gmail connector a builtin `google-workspace` sablonból.
 * Nem hard-coded OAuth URL — ugyanaz a materializáló út, mint a provisioning UI.
 */
export async function ensureTenantGmailConnector(
  db: ConnectorDb,
  tenantId: string,
  opts?: { name?: string; clientId?: string },
) {
  const rawDescriptor = BUILTIN_CONNECTOR_TEMPLATES.find((template) => template.key === 'google-workspace')
  if (!rawDescriptor) {
    throw new Error('builtin google-workspace template missing')
  }

  const descriptor = parseTemplateDescriptor(rawDescriptor)
  const config = materializeGmailConnectorConfig(
    descriptor,
    {
      authMethodKind: 'user_delegated_oauth2',
      instanceValues: {
        clientId: opts?.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID ?? 'stub-client-id',
      },
      selectedScopes: ['gmail.modify'],
    },
    {
      clientSecret:
        process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim() || 'secret://gmail/oauth-client',
    },
    { templateKey: descriptor.key, templateOrigin: 'builtin' },
  )

  const name = opts?.name ?? 'Gmail (felhasználói)'
  const connector = await upsertConnectorByTypeName(db, {
    create: {
      type: 'http_api',
      name,
      tenantId,
      authMode: 'user_delegated',
      scope: 'single',
      secretAlias: 'secret://gmail/oauth-client',
      version: 1,
      lifecycleState: 'active',
      config: config as unknown as Prisma.InputJsonValue,
    },
    update: {
      authMode: 'user_delegated',
      lifecycleState: 'active',
      config: config as unknown as Prisma.InputJsonValue,
    },
  })

  await ensureGmailProvisioningDraft(db, {
    tenantId,
    connectorId: connector.id,
    templateKey: descriptor.key,
    templateDescriptor: rawDescriptor,
  })

  return connector
}
