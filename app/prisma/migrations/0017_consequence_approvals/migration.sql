-- CreateEnum
CREATE TYPE "consequence_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "consequence_approvals" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "agent_version" INTEGER NOT NULL,
    "tenant_id" UUID,
    "acting_user_id" UUID,
    "ticket_id" UUID,
    "tool_name" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" "consequence_approval_status" NOT NULL DEFAULT 'pending',
    "blocked_tool_call_id" UUID,
    "result_meta" JSONB,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "consequence_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consequence_approvals_conversation_id_status_idx" ON "consequence_approvals"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "consequence_approvals_agent_id_status_idx" ON "consequence_approvals"("agent_id", "status");

-- CreateIndex
CREATE INDEX "consequence_approvals_expires_at_status_idx" ON "consequence_approvals"("expires_at", "status");

-- AddForeignKey
ALTER TABLE "consequence_approvals" ADD CONSTRAINT "consequence_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consequence_approvals" ADD CONSTRAINT "consequence_approvals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

