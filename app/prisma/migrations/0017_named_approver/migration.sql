ALTER TABLE "agents" ADD COLUMN "approver_user_id" UUID;
ALTER TABLE "connectors" ADD COLUMN "approver_user_id" UUID;
ALTER TABLE "gateway_operations" ADD COLUMN "designated_approver_user_id" UUID;
ALTER TABLE "gateway_operations" ADD COLUMN "designated_approver_name" TEXT;
