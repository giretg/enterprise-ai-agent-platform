import type { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import { BUILTIN_CONNECTOR_TEMPLATES } from '@/domain/connector-template/builtin-templates'
import { materializeGoogleDriveConnectorConfig } from '@/domain/connector-template/google-drive-connector-config'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import { upsertConnectorByTypeName } from '@/lib/connector-upsert'

type ConnectorDb = Pick<PrismaClient, 'connector' | 'connectorDraft'>

function sha256Hex(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

/**
 * Aktív Google Drive connectorhoz provisioning draft sor — különben nem jelenik meg a
 * provisioning UI „Aktivált kapcsolatok” listájában.
 */
export async function ensureGoogleDriveProvisioningDraft(
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
    warnings: ['Seed/backfill — provisioning draft a meglévő aktív Google Drive-hoz'],
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
 * Demo/dev seed: tenant-scope Google Drive connector a builtin `google-drive` sablonból.
 */
export async function ensureTenantGoogleDriveConnector(
  db: ConnectorDb,
  tenantId: string,
  opts?: { name?: string; clientId?: string },
) {
  const rawDescriptor = BUILTIN_CONNECTOR_TEMPLATES.find((template) => template.key === 'google-drive')
  if (!rawDescriptor) {
    throw new Error('builtin google-drive template missing')
  }

  const descriptor = parseTemplateDescriptor(rawDescriptor)
  const config = materializeGoogleDriveConnectorConfig(
    descriptor,
    {
      authMethodKind: 'user_delegated_oauth2',
      instanceValues: {
        clientId: opts?.clientId ?? process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID ?? 'stub-client-id',
      },
      selectedScopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
    },
    {
      clientSecret:
        process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?.trim() || 'secret://google-drive/oauth-client',
    },
    { templateKey: descriptor.key, templateOrigin: 'builtin' },
  )

  const name = opts?.name ?? 'Google Drive (felhasználói)'
  const connector = await upsertConnectorByTypeName(db, {
    create: {
      type: 'google_drive',
      name,
      tenantId,
      authMode: 'user_delegated',
      scope: 'single',
      secretAlias: 'secret://google-drive/oauth-client',
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

  await ensureGoogleDriveProvisioningDraft(db, {
    tenantId,
    connectorId: connector.id,
    templateKey: descriptor.key,
    templateDescriptor: rawDescriptor,
  })

  return connector
}
