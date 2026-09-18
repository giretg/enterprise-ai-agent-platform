-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'approver', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'redeemed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'offboarding', 'archived');

-- CreateEnum
CREATE TYPE "TenantMembershipStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('superadmin', 'platform_operator', 'platform_auditor');

-- CreateEnum
CREATE TYPE "PlatformMembershipStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "ResourceGrantType" AS ENUM ('agent');

-- CreateEnum
CREATE TYPE "ResourceAccessLevel" AS ENUM ('view', 'operate');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('draft', 'active', 'suspended', 'retired');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('google_drive', 'http_api');

-- CreateEnum
CREATE TYPE "ConnectorAuthMode" AS ENUM ('service', 'user_delegated', 'agent_owned');

-- CreateEnum
CREATE TYPE "ConnectorGrantStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "ConnectorScope" AS ENUM ('global', 'single');

-- CreateEnum
CREATE TYPE "ConnectorAccessMode" AS ENUM ('read', 'write');

-- CreateEnum
CREATE TYPE "connector_lifecycle_state" AS ENUM ('draft', 'validated', 'active', 'archived', 'blocked');

-- CreateEnum
CREATE TYPE "connector_draft_source_type" AS ENUM ('api_doc', 'openapi', 'manual', 'template');

-- CreateEnum
CREATE TYPE "connector_template_origin" AS ENUM ('builtin', 'custom');

-- CreateEnum
CREATE TYPE "connector_template_status" AS ENUM ('active', 'deprecated', 'archived');

-- CreateEnum
CREATE TYPE "connector_draft_review_status" AS ENUM ('pending', 'changes_requested', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "SkillCatalogScope" AS ENUM ('global', 'tenant');

-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('tenant', 'published', 'system');

-- CreateEnum
CREATE TYPE "SkillSourceType" AS ENUM ('authored', 'imported');

-- CreateEnum
CREATE TYPE "SkillRiskTier" AS ENUM ('t0', 't1', 't2', 't3');

-- CreateEnum
CREATE TYPE "SkillVersionStatus" AS ENUM ('proposed', 'approved', 'active', 'retired', 'rolled_back');

-- CreateEnum
CREATE TYPE "GatewayOperationStatus" AS ENUM ('requested', 'awaiting_approval', 'approved', 'rejected', 'executing', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "GatewayApprovalDecision" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "external_auth_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole",
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "invited_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "suspended_at" TIMESTAMPTZ,
    "suspended_by" UUID,
    "suspended_reason" TEXT,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "clerk_invitation_id" TEXT,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "redeemed_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "domain_allowlist" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "TenantMembershipStatus" NOT NULL DEFAULT 'pending',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "invited_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "status" "PlatformMembershipStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "platform_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "min_role" "UserRole" NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resource_type" "ResourceGrantType" NOT NULL,
    "resource_id" UUID NOT NULL,
    "access_level" "ResourceAccessLevel" NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role_instruction" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'draft',
    "current_definition_version_id" UUID,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "retired_at" TIMESTAMPTZ,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_definition_versions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_definition_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "description" TEXT NOT NULL,
    "catalogScope" "SkillCatalogScope" NOT NULL DEFAULT 'tenant',
    "tenant_id" UUID,
    "kind" "SkillKind" NOT NULL DEFAULT 'tenant',
    "sourceType" "SkillSourceType" NOT NULL DEFAULT 'authored',
    "provenance" JSONB,
    "license" TEXT,
    "riskTier" "SkillRiskTier" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "requires" JSONB NOT NULL,
    "attachments" JSONB,
    "status" "SkillVersionStatus" NOT NULL DEFAULT 'proposed',
    "content_hash" TEXT NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skills" (
    "agent_id" UUID NOT NULL,
    "skill_version_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("agent_id","skill_version_id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" UUID NOT NULL,
    "type" "ConnectorType" NOT NULL,
    "name" TEXT NOT NULL,
    "auth_mode" "ConnectorAuthMode" NOT NULL DEFAULT 'service',
    "scope" "ConnectorScope" NOT NULL,
    "secret_alias" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lifecycle_state" "connector_lifecycle_state" NOT NULL DEFAULT 'active',
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "origin" "connector_template_origin" NOT NULL DEFAULT 'custom',
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "tenant_id" UUID,
    "descriptor" JSONB NOT NULL,
    "status" "connector_template_status" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connector_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "source_type" "connector_draft_source_type" NOT NULL,
    "source_ref" TEXT,
    "source_hash" TEXT NOT NULL,
    "generated_by_agent_id" UUID,
    "validation_result" JSONB,
    "review_status" "connector_draft_review_status" NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "second_approver_id" UUID,
    "sandbox_test_ok" BOOLEAN,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connector_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "ConnectorGrantStatus" NOT NULL DEFAULT 'active',
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "token_ref" TEXT NOT NULL,
    "account_label" TEXT,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "last_refreshed_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "connector_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_connectors" (
    "agent_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "access_mode" "ConnectorAccessMode" NOT NULL,

    CONSTRAINT "agent_connectors_pkey" PRIMARY KEY ("agent_id","connector_id")
);

-- CreateTable
CREATE TABLE "capabilities" (
    "agent_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("agent_id","tool_name")
);

-- CreateTable
CREATE TABLE "gateway_operations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_definition_version_id" UUID NOT NULL,
    "principal_user_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "args_json" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "GatewayOperationStatus" NOT NULL,
    "connector_id" UUID,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gateway_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_approvals" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decision" "GatewayApprovalDecision" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_external_auth_id_key" ON "users"("external_auth_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_clerk_invitation_id_key" ON "invitations"("clerk_invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_status_idx" ON "invitations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenant_memberships_user_id_status_idx" ON "tenant_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "tenant_memberships_tenant_id_role_status_idx" ON "tenant_memberships"("tenant_id", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_key" ON "tenant_memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "platform_memberships_role_status_idx" ON "platform_memberships"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_memberships_user_id_role_key" ON "platform_memberships"("user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_permission_key_key" ON "role_permissions"("permission_key");

-- CreateIndex
CREATE INDEX "resource_grants_tenant_id_user_id_idx" ON "resource_grants"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "resource_grants_tenant_id_resource_id_idx" ON "resource_grants"("tenant_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_grants_tenant_id_user_id_resource_type_resource_id_key" ON "resource_grants"("tenant_id", "user_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_current_definition_version_id_key" ON "agents"("current_definition_version_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_status_idx" ON "agents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_definition_versions_agent_id_version_key" ON "agent_definition_versions"("agent_id", "version");

-- CreateIndex
CREATE INDEX "skills_tenant_id_idx" ON "skills"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_tenant_id_type_name_key" ON "connectors"("tenant_id", "type", "name");

-- CreateIndex
CREATE INDEX "connector_templates_origin_status_idx" ON "connector_templates"("origin", "status");

-- CreateIndex
CREATE UNIQUE INDEX "connector_templates_key_version_tenant_id_key" ON "connector_templates"("key", "version", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_drafts_connector_id_key" ON "connector_drafts"("connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_drafts_tenant_id_connector_id_key" ON "connector_drafts"("tenant_id", "connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_grants_token_ref_key" ON "connector_grants"("token_ref");

-- CreateIndex
CREATE UNIQUE INDEX "connector_grants_tenant_id_connector_id_user_id_key" ON "connector_grants"("tenant_id", "connector_id", "user_id");

-- CreateIndex
CREATE INDEX "gateway_operations_tenant_id_status_idx" ON "gateway_operations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_operations_tenant_id_idempotency_key_key" ON "gateway_operations"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_approvals_operation_id_key" ON "gateway_approvals"("operation_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_memberships" ADD CONSTRAINT "platform_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_definition_version_id_fkey" FOREIGN KEY ("current_definition_version_id") REFERENCES "agent_definition_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definition_versions" ADD CONSTRAINT "agent_definition_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definition_versions" ADD CONSTRAINT "agent_definition_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_templates" ADD CONSTRAINT "connector_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_drafts" ADD CONSTRAINT "connector_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_drafts" ADD CONSTRAINT "connector_drafts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_operations" ADD CONSTRAINT "gateway_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_operations" ADD CONSTRAINT "gateway_operations_agent_definition_version_id_fkey" FOREIGN KEY ("agent_definition_version_id") REFERENCES "agent_definition_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_operations" ADD CONSTRAINT "gateway_operations_principal_user_id_fkey" FOREIGN KEY ("principal_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_operations" ADD CONSTRAINT "gateway_operations_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_approvals" ADD CONSTRAINT "gateway_approvals_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "gateway_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_approvals" ADD CONSTRAINT "gateway_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

