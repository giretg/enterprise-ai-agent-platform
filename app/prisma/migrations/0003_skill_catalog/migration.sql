-- CreateEnum
CREATE TYPE "SkillCatalogScope" AS ENUM ('global', 'tenant');

-- CreateEnum
CREATE TYPE "SkillSourceType" AS ENUM ('authored', 'imported');

-- CreateEnum
CREATE TYPE "SkillRiskTier" AS ENUM ('t0', 't1', 't2', 't3');

-- CreateEnum
CREATE TYPE "SkillVersionStatus" AS ENUM ('proposed', 'approved', 'active', 'retired', 'rolled_back');

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "catalogScope" "SkillCatalogScope" NOT NULL DEFAULT 'tenant',
    "tenant_id" UUID,
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
    "status" "SkillVersionStatus" NOT NULL DEFAULT 'proposed',
    "content_hash" TEXT NOT NULL,
    "signature" TEXT,
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

-- CreateIndex
CREATE INDEX "skills_tenant_id_idx" ON "skills"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
