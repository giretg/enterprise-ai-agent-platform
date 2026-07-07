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
CREATE TYPE "ResourceGrantType" AS ENUM ('agent', 'playbook', 'ticket_type');

-- CreateEnum
CREATE TYPE "ResourceAccessLevel" AS ENUM ('view', 'operate', 'approve');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('draft', 'active', 'suspended', 'retired');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('worker', 'orchestrator');

-- CreateEnum
CREATE TYPE "PlaybookVersionStatus" AS ENUM ('proposed', 'active', 'retired');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "MemoryVersionStatus" AS ENUM ('proposed', 'active', 'rolled_back');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('secret', 'policy', 'file', 'dataset', 'connector', 'tool');

-- CreateEnum
CREATE TYPE "ResourceScope" AS ENUM ('global', 'group', 'single');

-- CreateEnum
CREATE TYPE "AccessMode" AS ENUM ('read', 'use');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('knowledge_base', 'board', 'gmail', 'workspace', 'http_api', 'web_search');

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
CREATE TYPE "ToolCallStatus" AS ENUM ('ok', 'denied', 'error');

-- CreateEnum
CREATE TYPE "ModelCallStatus" AS ENUM ('ok', 'error', 'rate_limited');

-- CreateEnum
CREATE TYPE "RecipeTicketType" AS ENUM ('interaction', 'training');

-- CreateEnum
CREATE TYPE "RecipeScope" AS ENUM ('global', 'single');

-- CreateEnum
CREATE TYPE "RecipeVersionStatus" AS ENUM ('proposed', 'active', 'retired');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('interaction', 'training', 'monitor_alert');

-- CreateEnum
CREATE TYPE "TicketState" AS ENUM ('backlog', 'ready', 'approved', 'in_progress', 'awaiting_human', 'needs_info', 'done', 'rejected');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('user', 'test', 'system');

-- CreateEnum
CREATE TYPE "ScheduledTaskStatus" AS ENUM ('active', 'materializing', 'materialized', 'revoked');

-- CreateEnum
CREATE TYPE "ScheduledTaskKind" AS ENUM ('agent_task', 'wiki_question');

-- CreateEnum
CREATE TYPE "ScheduledTaskRecurrence" AS ENUM ('none', 'daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "MonitorKind" AS ENUM ('board_backlog', 'deadline', 'connector_count', 'composite');

-- CreateEnum
CREATE TYPE "MonitorStatus" AS ENUM ('active', 'paused', 'revoked');

-- CreateEnum
CREATE TYPE "MonitorRunOutcome" AS ENUM ('quiet', 'escalated', 'suppressed', 'skipped', 'error');

-- CreateEnum
CREATE TYPE "MonitorCatchupPolicy" AS ENUM ('run_late', 'skip');

-- CreateEnum
CREATE TYPE "AssigneeType" AS ENUM ('human', 'agent');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('uploaded', 'processing', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "knowledge_processing_mode" AS ENUM ('raw_text_only', 'okf');

-- CreateEnum
CREATE TYPE "knowledge_artifact_status" AS ENUM ('draft', 'processing', 'pending_review', 'published', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "knowledge_artifact_format" AS ENUM ('okf_v0_1', 'markdown_bundle', 'raw_markdown', 'json');

-- CreateEnum
CREATE TYPE "knowledge_connector_sharing" AS ENUM ('single_agent', 'multi_agent');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('human', 'agent', 'system');

-- CreateEnum
CREATE TYPE "TicketCommentKind" AS ENUM ('human_comment', 'agent_answer', 'agent_progress', 'system_note');

-- CreateEnum
CREATE TYPE "TicketCommentAttachmentKind" AS ENUM ('file', 'screenshot');

-- CreateEnum
CREATE TYPE "SandboxAppLevel" AS ENUM ('A0', 'A1', 'A2', 'A3');

-- CreateEnum
CREATE TYPE "SandboxAppType" AS ENUM ('single_html', 'static_bundle', 'sandbox_data_app', 'integrated_app');

-- CreateEnum
CREATE TYPE "SandboxAppStatus" AS ENUM ('draft', 'active', 'archived', 'blocked');

-- CreateEnum
CREATE TYPE "SandboxAppVersionStatus" AS ENUM ('draft', 'active', 'superseded', 'blocked');

-- CreateEnum
CREATE TYPE "SandboxAppCriticality" AS ENUM ('L0', 'L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "SandboxCreatedByType" AS ENUM ('user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'agent', 'system', 'tool');

-- CreateEnum
CREATE TYPE "MessageCriticality" AS ENUM ('L0', 'L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "RetentionPolicyAppliesTo" AS ENUM ('all', 'agent');

-- CreateEnum
CREATE TYPE "PlaybookV2Status" AS ENUM ('draft', 'published', 'archived', 'blocked');

-- CreateEnum
CREATE TYPE "PlaybookVersionV2Status" AS ENUM ('draft', 'pending_approval', 'published', 'rejected', 'retired');

-- CreateEnum
CREATE TYPE "ProcessActorType" AS ENUM ('user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "ProcessStatus" AS ENUM ('created', 'running', 'awaiting_human', 'blocked', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProcessStepStatus" AS ENUM ('pending', 'ready', 'in_progress', 'awaiting_gate', 'completed', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "DelegationStatus" AS ENUM ('pending', 'delivered', 'accepted', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProcessDefinitionStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "ProcessTriggerType" AS ENUM ('manual', 'ticket', 'chat', 'monitor_cron');

-- CreateEnum
CREATE TYPE "StepTemplateStatus" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "model_routing_scope" AS ENUM ('global', 'agent', 'ticket_type');

-- CreateEnum
CREATE TYPE "model_budget_scope" AS ENUM ('tenant', 'agent', 'ticket_type');

-- CreateEnum
CREATE TYPE "model_budget_period" AS ENUM ('day', 'week', 'month');

-- CreateEnum
CREATE TYPE "SandboxEnv" AS ENUM ('test', 'live');

-- CreateEnum
CREATE TYPE "SandboxCommitSource" AS ENUM ('user', 'agent', 'system', 'import');

-- CreateEnum
CREATE TYPE "SandboxPromotionStatus" AS ENUM ('pending_approval', 'approved', 'promoted', 'rejected', 'rolled_back');

-- CreateEnum
CREATE TYPE "SandboxSnapshotKind" AS ENUM ('manual', 'pre_promotion', 'scheduled', 'pre_rollback');

-- CreateEnum
CREATE TYPE "SandboxSnapshotStatus" AS ENUM ('creating', 'available', 'restoring', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "SandboxExportStatus" AS ENUM ('requested', 'building', 'ready', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "SandboxExportScope" AS ENUM ('code_only', 'code_and_schema', 'full');

-- CreateEnum
CREATE TYPE "SandboxActorType" AS ENUM ('user', 'agent', 'system');

-- CreateEnum
CREATE TYPE "WriteGateTokenStatus" AS ENUM ('issued', 'consumed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "EvalStatus" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "EvalRunTrigger" AS ENUM ('pre_training_approval', 'scheduled', 'manual');

-- CreateTable
CREATE TABLE "role_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "key" "AgentRole" NOT NULL,
    "display_name" TEXT NOT NULL,
    "tool_access_allowed" BOOLEAN NOT NULL,
    "allowed_outbound" JSONB NOT NULL,
    "self_evolution_allowed" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "external_auth_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "job_description" TEXT,
    "role" "UserRole",
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "tenant_id" UUID,
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
    "tenant_id" UUID,
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
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "role_instruction" TEXT NOT NULL,
    "behavior_profile" TEXT NOT NULL,
    "behavior_profile_overlay" TEXT,
    "persona_nickname" TEXT,
    "persona_greeting" TEXT,
    "persona_trait" TEXT,
    "avatar_url" TEXT,
    "model_config" JSONB NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "current_role_instruction_version" INTEGER NOT NULL DEFAULT 1,
    "current_behavior_profile_version" INTEGER NOT NULL DEFAULT 1,
    "current_behavior_profile_id" UUID,
    "role" "AgentRole" NOT NULL DEFAULT 'worker',
    "self_evolution_profile" JSONB,
    "memory_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ,
    "suspended_reason" TEXT,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "behavior_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "behavior_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "behavior_profile_versions" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "behavior_profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "role_instruction_snapshot" TEXT NOT NULL,
    "behavior_profile_snapshot" TEXT NOT NULL,
    "role_instruction_version" INTEGER NOT NULL,
    "behavior_profile_version" INTEGER NOT NULL,
    "model_config_snapshot" JSONB NOT NULL,
    "memory_version_id" UUID NOT NULL,
    "recipe_version_id" UUID,
    "self_evolution_snapshot" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ticket_type" "RecipeTicketType" NOT NULL,
    "scope" "RecipeScope" NOT NULL DEFAULT 'single',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_versions" (
    "id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "status" "RecipeVersionStatus" NOT NULL DEFAULT 'proposed',
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbooks" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "process_type" TEXT NOT NULL,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_versions" (
    "id" UUID NOT NULL,
    "playbook_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "status" "PlaybookVersionStatus" NOT NULL DEFAULT 'proposed',
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbook_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbooks_v2" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "process_type" TEXT NOT NULL,
    "status" "PlaybookV2Status" NOT NULL DEFAULT 'draft',
    "current_published_version_id" UUID,
    "owner_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "playbooks_v2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_versions_v2" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "playbook_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlaybookVersionV2Status" NOT NULL DEFAULT 'draft',
    "spec" JSONB NOT NULL,
    "compiled_spec" JSONB,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "validation_result" JSONB NOT NULL DEFAULT '{}',
    "change_summary" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "published_at" TIMESTAMPTZ,
    "retired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbook_versions_v2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "playbook_id" UUID NOT NULL,
    "playbook_version_id" UUID NOT NULL,
    "assignment_type" TEXT NOT NULL,
    "assignment_key" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "playbook_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" "StepTemplateStatus" NOT NULL DEFAULT 'draft',
    "current_published_version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "step_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "fragment" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "certified" BOOLEAN NOT NULL DEFAULT false,
    "eval_samples" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_instances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "process_type" TEXT NOT NULL,
    "status" "ProcessStatus" NOT NULL DEFAULT 'created',
    "playbook_id" UUID NOT NULL,
    "playbook_version_id" UUID NOT NULL,
    "playbook_ref" TEXT NOT NULL,
    "playbook_content_hash" TEXT NOT NULL,
    "process_definition_id" UUID,
    "trigger_type" "ProcessTriggerType",
    "started_by_type" "ProcessActorType" NOT NULL,
    "started_by_user_id" UUID,
    "started_by_agent_id" UUID,
    "conversation_id" UUID,
    "root_ticket_id" UUID,
    "input_payload" JSONB NOT NULL DEFAULT '{}',
    "output_payload" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,

    CONSTRAINT "process_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_step_instances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "process_instance_id" UUID NOT NULL,
    "step_id" TEXT NOT NULL,
    "step_name" TEXT NOT NULL,
    "status" "ProcessStepStatus" NOT NULL DEFAULT 'pending',
    "assigned_role" TEXT NOT NULL,
    "assigned_agent_id" UUID,
    "assigned_user_id" UUID,
    "ticket_id" UUID,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "result_payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "process_step_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegation_edges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "process_instance_id" UUID NOT NULL,
    "from_step_id" TEXT NOT NULL,
    "to_step_id" TEXT NOT NULL,
    "from_ticket_id" UUID,
    "to_ticket_id" UUID,
    "from_actor_type" "ProcessActorType" NOT NULL,
    "from_agent_id" UUID,
    "from_user_id" UUID,
    "to_actor_type" "ProcessActorType" NOT NULL,
    "to_agent_id" UUID,
    "to_user_id" UUID,
    "status" "DelegationStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "done_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "delegation_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProcessDefinitionStatus" NOT NULL DEFAULT 'draft',
    "playbook_id" UUID NOT NULL,
    "playbook_version_id" UUID NOT NULL,
    "role_bindings" JSONB NOT NULL DEFAULT '{}',
    "config_values" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "process_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_triggers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "process_definition_id" UUID NOT NULL,
    "type" "ProcessTriggerType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "input_map" JSONB NOT NULL DEFAULT '{}',
    "monitor_definition_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "process_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_api_keys" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "agent_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "current_version_id" UUID,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_versions" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "diff_from_previous" JSONB,
    "status" "MemoryVersionStatus" NOT NULL DEFAULT 'proposed',
    "source" TEXT,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL,
    "type" "ResourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "ResourceScope" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_resources" (
    "agent_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "access_mode" "AccessMode" NOT NULL,

    CONSTRAINT "agent_resources_pkey" PRIMARY KEY ("agent_id","resource_id")
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
    "tenant_id" UUID,
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
    "tenant_id" UUID,
    "connector_id" UUID NOT NULL,
    "source_type" "connector_draft_source_type" NOT NULL,
    "source_ref" TEXT,
    "source_hash" TEXT NOT NULL,
    "generated_by_agent_id" UUID,
    "generated_by_agent_version" INTEGER,
    "generated_from_conversation_id" UUID,
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
    "tenant_id" UUID,
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

    CONSTRAINT "connector_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_connectors" (
    "agent_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "access_mode" "ConnectorAccessMode" NOT NULL,
    "secret_alias" TEXT,

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
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "extracted_text" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'uploaded',
    "connector_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mime_type" TEXT,
    "content_hash" TEXT,
    "processing_mode" "knowledge_processing_mode",
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "connector_id" UUID NOT NULL,
    "created_by_agent_id" UUID,
    "source_document_id" UUID,
    "format" "knowledge_artifact_format" NOT NULL DEFAULT 'okf_v0_1',
    "status" "knowledge_artifact_status" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "bundle_ref" TEXT NOT NULL,
    "generation_model" TEXT,
    "generation_prompt_hash" TEXT,
    "validation_result" JSONB NOT NULL DEFAULT '{}',
    "review_summary" TEXT,
    "created_by" UUID,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "knowledge_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "artifact_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "section" TEXT,
    "chunk_index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "summary" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "source_ref" JSONB,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "agent_id" UUID NOT NULL,
    "title" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "retention_policy_id" UUID,
    "retain_until" TIMESTAMPTZ,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "acting_user_id" UUID,
    "agent_version" INTEGER,
    "model" TEXT,
    "content_ref" TEXT,
    "content_hash" TEXT,
    "content_deleted_at" TIMESTAMPTZ,
    "ticket_ref" UUID,
    "audit_event_ref" TEXT,
    "criticality" "MessageCriticality",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "ttl_days" INTEGER NOT NULL,
    "applies_to" "RetentionPolicyAppliesTo" NOT NULL DEFAULT 'all',
    "agent_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "type" "TicketType" NOT NULL,
    "title" TEXT NOT NULL,
    "state" "TicketState" NOT NULL DEFAULT 'backlog',
    "assignee_type" "AssigneeType",
    "assignee_id" UUID,
    "agent_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "source_document_id" UUID,
    "execute_after" TIMESTAMPTZ,
    "due_by" TIMESTAMPTZ,
    "lock_token" TEXT,
    "locked_at" TIMESTAMPTZ,
    "playbook_ref" TEXT,
    "process_instance_id" UUID,
    "playbook_version_id" UUID,
    "playbook_step_id" TEXT,
    "required_gate_id" TEXT,
    "conversation_id" UUID,
    "source" "TicketSource" NOT NULL DEFAULT 'user',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" "ScheduledTaskKind" NOT NULL DEFAULT 'agent_task',
    "status" "ScheduledTaskStatus" NOT NULL DEFAULT 'active',
    "recurrence" "ScheduledTaskRecurrence" NOT NULL DEFAULT 'none',
    "max_runs" INTEGER,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "run_as_user_id" UUID,
    "run_as_authorized_at" TIMESTAMPTZ,
    "run_as_authorized_by" UUID,
    "next_run_at" TIMESTAMPTZ NOT NULL,
    "last_run_at" TIMESTAMPTZ,
    "materialized_ticket_id" UUID,
    "materialized_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "MonitorKind" NOT NULL,
    "status" "MonitorStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "interval_seconds" INTEGER NOT NULL,
    "next_sweep_at" TIMESTAMPTZ NOT NULL,
    "last_sweep_at" TIMESTAMPTZ,
    "active_window_cron" TEXT,
    "catchup_policy" "MonitorCatchupPolicy" NOT NULL DEFAULT 'run_late',
    "catchup_window_sec" INTEGER NOT NULL DEFAULT 900,
    "collector_config" JSONB NOT NULL DEFAULT '{}',
    "filter_config" JSONB NOT NULL DEFAULT '{}',
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 86400,
    "dedup_key_template" TEXT,
    "open_ticket_type" "TicketType" NOT NULL DEFAULT 'monitor_alert',
    "escalate_agent_id" UUID,
    "per_run_budget_usd" DECIMAL(10,4),
    "notify_channel" TEXT,
    "lock_token" TEXT,
    "locked_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "monitor_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_runs" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "outcome" "MonitorRunOutcome" NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "suppressed_count" INTEGER NOT NULL DEFAULT 0,
    "opened_ticket_ids" UUID[],
    "llm_invoked" BOOLEAN NOT NULL DEFAULT false,
    "cost_usd" DECIMAL(10,4),
    "error" TEXT,

    CONSTRAINT "monitor_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_signals" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_escalated_at" TIMESTAMPTZ,
    "escalated_ticket_id" UUID,
    "severity" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "monitor_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_transitions" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_state" "TicketState" NOT NULL,
    "to_state" "TicketState" NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "agent_version" INTEGER,
    "note" TEXT,
    "ts" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "TicketCommentKind" NOT NULL,
    "author_type" "AuditActorType" NOT NULL,
    "author_user_id" UUID,
    "author_agent_id" UUID,
    "author_display_name" TEXT,
    "agent_version" INTEGER,
    "body" TEXT NOT NULL,
    "structured" JSONB,
    "parent_id" UUID,
    "transition_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comment_attachments" (
    "id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "TicketCommentAttachmentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT,
    "byte_size" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comment_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "agent_version" INTEGER,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "model_used" TEXT,
    "input_ref" TEXT,
    "output_ref" TEXT,
    "policy_decision" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID,
    "ticket_id" UUID,
    "conversation_id" UUID,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_calls" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "agent_version" INTEGER,
    "ticket_id" UUID,
    "conversation_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "cost_estimate" DECIMAL(12,6) NOT NULL,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "status" "ModelCallStatus" NOT NULL DEFAULT 'ok',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routing_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "scope" "model_routing_scope" NOT NULL DEFAULT 'global',
    "scope_ref" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "model_routing_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_budgets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "scope" "model_budget_scope" NOT NULL DEFAULT 'tenant',
    "scope_ref" TEXT,
    "period" "model_budget_period" NOT NULL DEFAULT 'week',
    "call_limit" INTEGER,
    "token_limit" INTEGER,
    "soft_threshold" DECIMAL(12,6),
    "hard_cap" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "model_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "ticket_id" UUID,
    "conversation_id" UUID,
    "connector_id" UUID,
    "tool_name" TEXT NOT NULL,
    "status" "ToolCallStatus" NOT NULL,
    "args_meta" JSONB NOT NULL DEFAULT '{}',
    "result_meta" JSONB,
    "latency_ms" INTEGER NOT NULL,
    "policy_decision" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_apps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "sandbox_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "level" "SandboxAppLevel" NOT NULL DEFAULT 'A0',
    "type" "SandboxAppType" NOT NULL DEFAULT 'single_html',
    "status" "SandboxAppStatus" NOT NULL DEFAULT 'draft',
    "criticality" "SandboxAppCriticality" NOT NULL DEFAULT 'L1',
    "active_version_id" UUID,
    "created_by_type" "SandboxCreatedByType" NOT NULL,
    "created_by_user_id" UUID,
    "created_by_agent_id" UUID,
    "created_from_ticket_id" UUID,
    "created_from_conversation_id" UUID,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sandbox_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_app_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "app_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SandboxAppVersionStatus" NOT NULL DEFAULT 'draft',
    "change_summary" TEXT NOT NULL,
    "artifact_ref" TEXT NOT NULL,
    "artifact_size_bytes" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'text/html; charset=utf-8',
    "created_by_type" "SandboxCreatedByType" NOT NULL,
    "created_by_user_id" UUID,
    "created_by_agent_id" UUID,
    "created_from_run_id" UUID,
    "source_ticket_id" UUID,
    "validation_result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "sandbox_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "test_commit_id" UUID,
    "live_commit_id" UUID,
    "head_commit_id" UUID,
    "data_binding" JSONB NOT NULL DEFAULT '{}',
    "portability" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sandbox_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_commits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "parent_commit_id" UUID,
    "based_on_commit_id" UUID,
    "source" "SandboxCommitSource" NOT NULL,
    "change_summary" TEXT NOT NULL,
    "tree_ref" TEXT NOT NULL,
    "tree_hash" TEXT NOT NULL,
    "file_count" INTEGER NOT NULL,
    "total_size_bytes" BIGINT NOT NULL,
    "created_by_type" "SandboxActorType" NOT NULL,
    "created_by_user_id" UUID,
    "created_by_agent_id" UUID,
    "created_from_ticket_id" UUID,
    "created_from_run_id" UUID,
    "build_cost" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_promotions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_id" UUID NOT NULL,
    "from_commit_id" UUID NOT NULL,
    "prev_live_commit_id" UUID,
    "pre_promotion_snapshot_id" UUID,
    "status" "SandboxPromotionStatus" NOT NULL DEFAULT 'pending_approval',
    "requested_by_type" "SandboxActorType" NOT NULL,
    "requested_by_user_id" UUID,
    "requested_by_agent_id" UUID,
    "approved_by_user_id" UUID,
    "reason" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "promoted_at" TIMESTAMPTZ,

    CONSTRAINT "sandbox_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_data_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_id" UUID NOT NULL,
    "env" "SandboxEnv" NOT NULL,
    "kind" "SandboxSnapshotKind" NOT NULL,
    "status" "SandboxSnapshotStatus" NOT NULL DEFAULT 'creating',
    "snapshot_ref" TEXT NOT NULL,
    "schema_hash" TEXT NOT NULL,
    "row_count" BIGINT,
    "size_bytes" BIGINT,
    "created_by_type" "SandboxActorType" NOT NULL,
    "created_by_user_id" UUID,
    "linked_promotion_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "sandbox_data_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "project_id" UUID NOT NULL,
    "scope" "SandboxExportScope" NOT NULL,
    "source_commit_id" UUID NOT NULL,
    "source_snapshot_id" UUID,
    "status" "SandboxExportStatus" NOT NULL DEFAULT 'requested',
    "package_ref" TEXT,
    "package_hash" TEXT,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "responsibility_transferred" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "sandbox_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "write_gate_tokens" (
    "id" UUID NOT NULL,
    "training_ticket_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "target_memory_id" UUID NOT NULL,
    "expected_diff_hash" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "WriteGateTokenStatus" NOT NULL DEFAULT 'issued',
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "write_gate_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_tickets" (
    "ticket_id" UUID NOT NULL,
    "proposed_diff" JSONB NOT NULL,
    "write_gate_token_ref" TEXT,
    "eval_result" JSONB,
    "target_memory_version" INTEGER NOT NULL,

    CONSTRAINT "training_tickets_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateTable
CREATE TABLE "evals" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "golden_set" JSONB NOT NULL,
    "status" "EvalStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "evals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL,
    "eval_id" UUID NOT NULL,
    "trigger" "EvalRunTrigger" NOT NULL,
    "agent_version" INTEGER NOT NULL,
    "memory_version_id" UUID,
    "passed" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "role_templates_tenant_id_key_key" ON "role_templates"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "users_external_auth_id_key" ON "users"("external_auth_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "users_tenant_id_role_idx" ON "users"("tenant_id", "role");

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
CREATE UNIQUE INDEX "agents_memory_id_key" ON "agents"("memory_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_status_idx" ON "agents"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "agents_tenant_id_role_idx" ON "agents"("tenant_id", "role");

-- CreateIndex
CREATE INDEX "agents_current_behavior_profile_id_idx" ON "agents"("current_behavior_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "behavior_profile_versions_profile_id_version_key" ON "behavior_profile_versions"("profile_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_recipe_id_version_key" ON "recipe_versions"("recipe_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_versions_playbook_id_version_key" ON "playbook_versions"("playbook_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "playbooks_v2_tenant_id_key_key" ON "playbooks_v2"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_versions_v2_playbook_id_version_key" ON "playbook_versions_v2"("playbook_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_versions_v2_tenant_id_playbook_id_content_hash_key" ON "playbook_versions_v2"("tenant_id", "playbook_id", "content_hash");

-- CreateIndex
CREATE INDEX "playbook_assignments_tenant_id_assignment_type_assignment_k_idx" ON "playbook_assignments"("tenant_id", "assignment_type", "assignment_key");

-- CreateIndex
CREATE UNIQUE INDEX "step_templates_tenant_id_key_key" ON "step_templates"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "step_template_versions_template_id_version_key" ON "step_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "process_instances_tenant_id_status_idx" ON "process_instances"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "process_instances_tenant_id_process_type_idx" ON "process_instances"("tenant_id", "process_type");

-- CreateIndex
CREATE INDEX "process_instances_process_definition_id_idx" ON "process_instances"("process_definition_id");

-- CreateIndex
CREATE INDEX "process_step_instances_tenant_id_status_idx" ON "process_step_instances"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "process_step_instances_process_instance_id_step_id_key" ON "process_step_instances"("process_instance_id", "step_id");

-- CreateIndex
CREATE INDEX "delegation_edges_tenant_id_process_instance_id_idx" ON "delegation_edges"("tenant_id", "process_instance_id");

-- CreateIndex
CREATE INDEX "process_definitions_tenant_id_status_idx" ON "process_definitions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "process_triggers_tenant_id_type_idx" ON "process_triggers"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "process_triggers_process_definition_id_idx" ON "process_triggers"("process_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_versions_memory_id_version_key" ON "memory_versions"("memory_id", "version");

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
CREATE INDEX "knowledge_artifacts_tenant_id_connector_id_status_idx" ON "knowledge_artifacts"("tenant_id", "connector_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_artifacts_connector_id_status_idx" ON "knowledge_artifacts"("connector_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_artifacts_connector_id_source_document_id_version_key" ON "knowledge_artifacts"("connector_id", "source_document_id", "version");

-- CreateIndex
CREATE INDEX "knowledge_chunks_tenant_id_connector_id_idx" ON "knowledge_chunks"("tenant_id", "connector_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_connector_id_idx" ON "knowledge_chunks"("connector_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_artifact_id_path_idx" ON "knowledge_chunks"("artifact_id", "path");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_agent_id_last_message_at_idx" ON "conversations"("tenant_id", "agent_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_created_by_idx" ON "conversations"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "conversations_retain_until_legal_hold_idx" ON "conversations"("retain_until", "legal_hold");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_content_deleted_at_idx" ON "messages"("content_deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "retention_policies_tenant_id_applies_to_idx" ON "retention_policies"("tenant_id", "applies_to");

-- CreateIndex
CREATE INDEX "retention_policies_tenant_id_agent_id_idx" ON "retention_policies"("tenant_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_tenant_id_name_key" ON "retention_policies"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "tickets_source_state_idx" ON "tickets"("source", "state");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_state_idx" ON "tickets"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "scheduled_tasks_status_next_run_at_idx" ON "scheduled_tasks"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "monitor_definitions_status_next_sweep_at_idx" ON "monitor_definitions"("status", "next_sweep_at");

-- CreateIndex
CREATE INDEX "monitor_definitions_tenant_id_status_idx" ON "monitor_definitions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "monitor_runs_monitor_id_started_at_idx" ON "monitor_runs"("monitor_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_runs_monitor_id_scheduled_for_key" ON "monitor_runs"("monitor_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "monitor_signals_monitor_id_last_escalated_at_idx" ON "monitor_signals"("monitor_id", "last_escalated_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_signals_monitor_id_dedup_key_key" ON "monitor_signals"("monitor_id", "dedup_key");

-- CreateIndex
CREATE INDEX "ticket_transitions_ticket_id_ts_idx" ON "ticket_transitions"("ticket_id", "ts");

-- CreateIndex
CREATE INDEX "ticket_comments_ticket_id_created_at_idx" ON "ticket_comments"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_comments_ticket_id_seq_key" ON "ticket_comments"("ticket_id", "seq");

-- CreateIndex
CREATE INDEX "ticket_comment_attachments_document_id_idx" ON "ticket_comment_attachments"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_comment_attachments_comment_id_seq_key" ON "ticket_comment_attachments"("comment_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_comment_attachments_document_id_key" ON "ticket_comment_attachments"("document_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_ticket_id_idx" ON "audit_log"("ticket_id");

-- CreateIndex
CREATE INDEX "audit_log_conversation_id_idx" ON "audit_log"("conversation_id");

-- CreateIndex
CREATE INDEX "model_routing_policies_tenant_id_scope_priority_idx" ON "model_routing_policies"("tenant_id", "scope", "priority");

-- CreateIndex
CREATE INDEX "model_budgets_tenant_id_scope_idx" ON "model_budgets"("tenant_id", "scope");

-- CreateIndex
CREATE INDEX "sandbox_apps_tenant_id_status_idx" ON "sandbox_apps"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "sandbox_apps_tenant_id_sandbox_id_idx" ON "sandbox_apps"("tenant_id", "sandbox_id");

-- CreateIndex
CREATE INDEX "sandbox_apps_tenant_id_created_from_ticket_id_idx" ON "sandbox_apps"("tenant_id", "created_from_ticket_id");

-- CreateIndex
CREATE INDEX "sandbox_app_versions_source_ticket_id_idx" ON "sandbox_app_versions"("source_ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_app_versions_app_id_version_key" ON "sandbox_app_versions"("app_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_app_versions_tenant_id_app_id_content_hash_key" ON "sandbox_app_versions"("tenant_id", "app_id", "content_hash");

-- CreateIndex
CREATE INDEX "sandbox_projects_tenant_id_sandbox_id_idx" ON "sandbox_projects"("tenant_id", "sandbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_projects_tenant_id_sandbox_id_name_key" ON "sandbox_projects"("tenant_id", "sandbox_id", "name");

-- CreateIndex
CREATE INDEX "sandbox_commits_tenant_id_project_id_tree_hash_idx" ON "sandbox_commits"("tenant_id", "project_id", "tree_hash");

-- CreateIndex
CREATE INDEX "sandbox_commits_project_id_idx" ON "sandbox_commits"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_commits_project_id_seq_key" ON "sandbox_commits"("project_id", "seq");

-- CreateIndex
CREATE INDEX "sandbox_promotions_project_id_status_idx" ON "sandbox_promotions"("project_id", "status");

-- CreateIndex
CREATE INDEX "sandbox_data_snapshots_project_id_env_idx" ON "sandbox_data_snapshots"("project_id", "env");

-- CreateIndex
CREATE INDEX "sandbox_exports_project_id_status_idx" ON "sandbox_exports"("project_id", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_behavior_profile_id_fkey" FOREIGN KEY ("current_behavior_profile_id") REFERENCES "behavior_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "behavior_profile_versions" ADD CONSTRAINT "behavior_profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "behavior_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_memory_version_id_fkey" FOREIGN KEY ("memory_version_id") REFERENCES "memory_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_versions_v2" ADD CONSTRAINT "playbook_versions_v2_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_assignments" ADD CONSTRAINT "playbook_assignments_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_assignments" ADD CONSTRAINT "playbook_assignments_playbook_version_id_fkey" FOREIGN KEY ("playbook_version_id") REFERENCES "playbook_versions_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_template_versions" ADD CONSTRAINT "step_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "step_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks_v2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_playbook_version_id_fkey" FOREIGN KEY ("playbook_version_id") REFERENCES "playbook_versions_v2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_process_definition_id_fkey" FOREIGN KEY ("process_definition_id") REFERENCES "process_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_step_instances" ADD CONSTRAINT "process_step_instances_process_instance_id_fkey" FOREIGN KEY ("process_instance_id") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_edges" ADD CONSTRAINT "delegation_edges_process_instance_id_fkey" FOREIGN KEY ("process_instance_id") REFERENCES "process_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_definitions" ADD CONSTRAINT "process_definitions_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks_v2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_definitions" ADD CONSTRAINT "process_definitions_playbook_version_id_fkey" FOREIGN KEY ("playbook_version_id") REFERENCES "playbook_versions_v2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_triggers" ADD CONSTRAINT "process_triggers_process_definition_id_fkey" FOREIGN KEY ("process_definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "memory_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_resources" ADD CONSTRAINT "agent_resources_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_resources" ADD CONSTRAINT "agent_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_drafts" ADD CONSTRAINT "connector_drafts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_artifacts" ADD CONSTRAINT "knowledge_artifacts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_artifacts" ADD CONSTRAINT "knowledge_artifacts_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "knowledge_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "retention_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_acting_user_id_fkey" FOREIGN KEY ("acting_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_ref_fkey" FOREIGN KEY ("ticket_ref") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_run_as_user_id_fkey" FOREIGN KEY ("run_as_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_run_as_authorized_by_fkey" FOREIGN KEY ("run_as_authorized_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_materialized_ticket_id_fkey" FOREIGN KEY ("materialized_ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_definitions" ADD CONSTRAINT "monitor_definitions_escalate_agent_id_fkey" FOREIGN KEY ("escalate_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_definitions" ADD CONSTRAINT "monitor_definitions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_runs" ADD CONSTRAINT "monitor_runs_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitor_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_signals" ADD CONSTRAINT "monitor_signals_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitor_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_transitions" ADD CONSTRAINT "ticket_transitions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ticket_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comment_attachments" ADD CONSTRAINT "ticket_comment_attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "ticket_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comment_attachments" ADD CONSTRAINT "ticket_comment_attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_app_versions" ADD CONSTRAINT "sandbox_app_versions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "sandbox_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_app_versions" ADD CONSTRAINT "sandbox_app_versions_source_ticket_id_fkey" FOREIGN KEY ("source_ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_commits" ADD CONSTRAINT "sandbox_commits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "sandbox_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_promotions" ADD CONSTRAINT "sandbox_promotions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "sandbox_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_data_snapshots" ADD CONSTRAINT "sandbox_data_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "sandbox_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_exports" ADD CONSTRAINT "sandbox_exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "sandbox_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_gate_tokens" ADD CONSTRAINT "write_gate_tokens_training_ticket_id_fkey" FOREIGN KEY ("training_ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_gate_tokens" ADD CONSTRAINT "write_gate_tokens_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_gate_tokens" ADD CONSTRAINT "write_gate_tokens_target_memory_id_fkey" FOREIGN KEY ("target_memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_tickets" ADD CONSTRAINT "training_tickets_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evals" ADD CONSTRAINT "evals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_id_fkey" FOREIGN KEY ("eval_id") REFERENCES "evals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_memory_version_id_fkey" FOREIGN KEY ("memory_version_id") REFERENCES "memory_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

