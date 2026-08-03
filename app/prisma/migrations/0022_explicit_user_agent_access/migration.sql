-- Ember→agent kapcsolatok: kiindulás = explicit grant mindenkinek, inbound zárva.
-- Nincs többé „alapból mindenkié” user→agent állapot (Web-Egress kivétel).
-- Az agent→agent delegációt ez NEM érinti: azt a forrás outboundRestricted +
-- agent→agent grantok szabályozzák (evaluate: agent subjectnél csak outbound).

ALTER TABLE "agents" ALTER COLUMN "inbound_restricted" SET DEFAULT true;

UPDATE "agents"
SET "inbound_restricted" = true
WHERE "tenant_id" IS NOT NULL
  AND ("system_role" IS DISTINCT FROM 'web_egress');

-- Hiányzó user→agent élek: pending+active tagság × normál tenant-agent, mindkét ige be.
INSERT INTO "agent_access_grants" (
  "id",
  "tenant_id",
  "subject_type",
  "subject_user_id",
  "subject_agent_id",
  "target_agent_id",
  "can_view",
  "can_address",
  "granted_by",
  "granted_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  a."tenant_id",
  'user',
  m."user_id",
  NULL,
  a."id",
  true,
  true,
  COALESCE(
    (
      SELECT m_admin."user_id"
      FROM "tenant_memberships" m_admin
      WHERE m_admin."tenant_id" = a."tenant_id"
        AND m_admin."role" = 'admin'
        AND m_admin."status" IN ('active', 'pending')
      ORDER BY m_admin."created_at" ASC
      LIMIT 1
    ),
    m."user_id"
  ),
  NOW(),
  NOW()
FROM "agents" a
INNER JOIN "tenant_memberships" m ON m."tenant_id" = a."tenant_id"
INNER JOIN "users" u ON u."id" = m."user_id"
WHERE a."tenant_id" IS NOT NULL
  AND (a."system_role" IS DISTINCT FROM 'web_egress')
  AND m."status" IN ('active', 'pending')
  AND u."status" IN ('active', 'pending')
  AND NOT EXISTS (
    SELECT 1
    FROM "agent_access_grants" g
    WHERE g."tenant_id" = a."tenant_id"
      AND g."subject_user_id" = m."user_id"
      AND g."target_agent_id" = a."id"
  );
