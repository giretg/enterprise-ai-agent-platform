-- issue #220 — connector-szintű írási bizalom (writeApproval: per_call | preapproved)

CREATE TYPE "WriteApprovalMode" AS ENUM ('per_call', 'preapproved');
CREATE TYPE "PreapprovedTrustMode" AS ENUM ('lax', 'strict');
CREATE TYPE "ConsequenceBoundary" AS ENUM ('external_draft', 'platform');

ALTER TABLE "agent_connectors"
  ADD COLUMN "write_approval" "WriteApprovalMode" NOT NULL DEFAULT 'per_call',
  ADD COLUMN "preapproved_trust_mode" "PreapprovedTrustMode",
  ADD COLUMN "preapproved_expires_at" TIMESTAMPTZ,
  ADD COLUMN "preapproved_write_limit" INTEGER,
  ADD COLUMN "danger_preapproved" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "connectors"
  ADD COLUMN "consequence_boundary" "ConsequenceBoundary";
