-- AlterTable
ALTER TABLE "agents" ADD COLUMN "http_api_write_mode" "MemoryWriteMode" NOT NULL DEFAULT 'approval';
ALTER TABLE "agents" ADD COLUMN "gmail_write_mode" "MemoryWriteMode" NOT NULL DEFAULT 'approval';
ALTER TABLE "agents" ADD COLUMN "drive_write_mode" "MemoryWriteMode" NOT NULL DEFAULT 'approval';
