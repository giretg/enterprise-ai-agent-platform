-- #640: ütemezett feladat. A platform a kanonikus példány; a harness saját ütemezője
-- egy vékony csonkot futtat. Egy időpont = egy futás: (task_id, slot, claim_key) unique.

-- CreateEnum
CREATE TYPE "ScheduledTaskStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ScheduledTaskRunStatus" AS ENUM ('running', 'succeeded', 'failed', 'missed');

-- CreateEnum
CREATE TYPE "ScheduledTaskKind" AS ENUM ('personal', 'team', 'shared');

-- CreateEnum
CREATE TYPE "ScheduledTaskAudience" AS ENUM ('selected', 'agent_operators');

-- CreateEnum
CREATE TYPE "ScheduledTaskMemberState" AS ENUM ('invited', 'active', 'needs_reconsent', 'declined', 'left');

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "kind" "ScheduledTaskKind" NOT NULL DEFAULT 'personal',
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "grace_minutes" INTEGER,
    "targets" TEXT[],
    "audience" "ScheduledTaskAudience" NOT NULL DEFAULT 'selected',
    "owner_sees_results" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schedule_hash" TEXT NOT NULL,
    "status" "ScheduledTaskStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_task_installations" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_type" TEXT NOT NULL,
    "client_instance_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "installed_schedule_hash" TEXT NOT NULL,
    "installed_stub_hash" TEXT NOT NULL,
    "installed_version" INTEGER NOT NULL,
    "locally_disabled" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "last_sync_at" TIMESTAMPTZ,
    "removed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_task_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_task_members" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state" "ScheduledTaskMemberState" NOT NULL DEFAULT 'invited',
    "accepted_version" INTEGER,
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scheduled_task_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_task_runs" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "slot" TIMESTAMPTZ NOT NULL,
    "installation_id" UUID,
    "runner_user_id" UUID NOT NULL,
    "claim_key" TEXT NOT NULL DEFAULT '',
    "task_version" INTEGER NOT NULL,
    "definition_version_id" UUID,
    "status" "ScheduledTaskRunStatus" NOT NULL,
    "owner_sees_results" BOOLEAN NOT NULL DEFAULT false,
    "catch_up" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "scheduled_task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_tasks_tenant_id_owner_user_id_status_idx" ON "scheduled_tasks"("tenant_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "scheduled_tasks_tenant_id_agent_id_idx" ON "scheduled_tasks"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "scheduled_task_installations_task_id_removed_at_idx" ON "scheduled_task_installations"("task_id", "removed_at");

-- CreateIndex
CREATE INDEX "scheduled_task_installations_user_id_client_type_client_ins_idx" ON "scheduled_task_installations"("user_id", "client_type", "client_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_task_installations_task_id_client_type_client_ins_key" ON "scheduled_task_installations"("task_id", "client_type", "client_instance_id", "external_id");

-- CreateIndex
CREATE INDEX "scheduled_task_members_user_id_state_idx" ON "scheduled_task_members"("user_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_task_members_task_id_user_id_key" ON "scheduled_task_members"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "scheduled_task_runs_runner_user_id_status_started_at_idx" ON "scheduled_task_runs"("runner_user_id", "status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_task_runs_task_id_slot_claim_key_key" ON "scheduled_task_runs"("task_id", "slot", "claim_key");

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_task_installations" ADD CONSTRAINT "scheduled_task_installations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_task_members" ADD CONSTRAINT "scheduled_task_members_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_task_members" ADD CONSTRAINT "scheduled_task_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

