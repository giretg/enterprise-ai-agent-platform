/**
 * Phase F seed: one Drive-ready tenant with a published, active Agent Definition
 * and a write-bound Google Drive connector. After `prisma migrate reset` the
 * MCP harness can run the full Core MVP scenario without a Control Plane ritual.
 *
 * MCP mapping needs SEED_CLERK_USER_ID = the Clerk user id of the human who
 * will run Codex / Claude Code. The placeholder id means Control Plane works;
 * MCP resolves `user_inactive` until the Clerk id is patched.
 *
 * Supported reset: `prisma migrate reset`.
 */
import { prisma } from '../src/lib/db'
import { services } from '../src/domain/gateway-services'
import { ensureTenantGoogleDriveConnector } from '../src/lib/seed-google-drive-connector'
import { ensureTenantAgentScaffold } from '../src/domain/agent-scaffold-materialization'
import { repositories } from '../src/repositories/postgres'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/custom-template-seeds'
import type { TemplateDescriptor } from '../src/domain/connector-template/template-descriptor'
import type { Prisma } from '@prisma/client'
import { withTemplateIcon } from './template-icons'

const SEED_TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? 'demo'
const SEED_CLERK_USER_ID = process.env.SEED_CLERK_USER_ID ?? 'seed-clerk-user'

async function upsertTemplates(
  origin: 'builtin' | 'custom',
  descriptors: TemplateDescriptor[],
) {
  for (const descriptor of descriptors) {
    const existing = await prisma.connectorTemplate.findFirst({
      where: { key: descriptor.key, version: 1, tenantId: null, origin },
    })
    const withIcon = withTemplateIcon(descriptor, existing?.descriptor)
    const data = {
      displayName: withIcon.displayName,
      description: withIcon.description ?? null,
      descriptor: withIcon as Prisma.InputJsonValue,
      status: 'active' as const,
    }
    if (!existing) {
      await prisma.connectorTemplate.create({
        data: {
          key: descriptor.key,
          version: 1,
          origin,
          tenantId: null,
          ...data,
        },
      })
      continue
    }
    await prisma.connectorTemplate.update({ where: { id: existing.id }, data })
  }
}

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: SEED_TENANT_SLUG },
    update: { status: 'active', displayName: 'Demo' },
    create: {
      slug: SEED_TENANT_SLUG,
      displayName: 'Demo',
      status: 'active',
    },
  })

  const user = await prisma.user.upsert({
    where: { externalAuthId: SEED_CLERK_USER_ID },
    update: { status: 'active', name: 'Demo admin', email: 'demo@example.com' },
    create: {
      externalAuthId: SEED_CLERK_USER_ID,
      email: 'demo@example.com',
      name: 'Demo admin',
      role: 'admin',
      status: 'active',
      activatedAt: new Date(),
    },
  })

  await prisma.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    update: { role: 'admin', status: 'active', isDefault: true },
    create: {
      tenantId: tenant.id,
      userId: user.id,
      role: 'admin',
      status: 'active',
      isDefault: true,
      activatedAt: new Date(),
    },
  })

  await upsertTemplates('builtin', BUILTIN_CONNECTOR_TEMPLATES)
  await upsertTemplates('custom', GLOBAL_CUSTOM_CONNECTOR_TEMPLATES)

  const connector = await ensureTenantGoogleDriveConnector(prisma, tenant.id)

  await prisma.connectorGrant.upsert({
    where: {
      tenantId_connectorId_userId: {
        tenantId: tenant.id,
        connectorId: connector.id,
        userId: user.id,
      },
    },
    update: {
      status: 'active',
      tokenRef: `stub-seed-drive-grant:${user.id}`,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
    },
    create: {
      tenantId: tenant.id,
      connectorId: connector.id,
      userId: user.id,
      status: 'active',
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
      tokenRef: `stub-seed-drive-grant:${user.id}`,
      accountLabel: 'seed-placeholder',
    },
  })

  const agent = await prisma.agent.upsert({
    where: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    update: {
      tenantId: tenant.id,
      name: 'Drive assistant',
      roleInstruction:
        'You inspect Google Drive through MCP. Search and read files, and request folder creation for the signed-in operator. Folder writes wait for human approval. Do not invent Drive contents.',
      status: 'draft',
    },
    create: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: tenant.id,
      name: 'Drive assistant',
      roleInstruction:
        'You inspect Google Drive through MCP. Search and read files, and request folder creation for the signed-in operator. Folder writes wait for human approval. Do not invent Drive contents.',
      status: 'draft',
    },
  })

  await prisma.capability.deleteMany({ where: { agentId: agent.id } })
  await prisma.capability.createMany({
    data: [
      { agentId: agent.id, toolName: 'google_drive_search', allowed: true },
      { agentId: agent.id, toolName: 'google_drive_read_file', allowed: true },
      { agentId: agent.id, toolName: 'google_drive_create_folder', allowed: true },
    ],
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId: agent.id, connectorId: connector.id } },
    update: { accessMode: 'write' },
    create: { agentId: agent.id, connectorId: connector.id, accessMode: 'write' },
  })

  const published = await services.agentDefinitions.publishAgentDefinition({
    agentId: agent.id,
    tenantId: tenant.id,
    publishedById: user.id,
  })
  const activated = await services.agentDefinitions.activateAgent({
    agentId: agent.id,
    tenantId: tenant.id,
    actorId: user.id,
  })

  const scaffold = await ensureTenantAgentScaffold(
    {
      agents: repositories.agents,
      versions: repositories.agentDefinitions,
      skills: repositories.skills,
    },
    { tenantId: tenant.id, publishedById: user.id },
  )

  console.log(
    `Seeded tenant slug=${tenant.slug} agent=${agent.id} status=${activated.status} definition=${published.definitionId} scaffold=${scaffold.id} clerk=${SEED_CLERK_USER_ID}`,
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
