-- Append-only enforcement for audit_log (AuditLog-Observability feature-spec §2/2, §4).
--
-- The table owner (neondb_owner) implicitly holds every privilege, so a plain
-- REVOKE UPDATE/DELETE would not constrain it. Enforcement is therefore done with
-- a BEFORE UPDATE/DELETE trigger that fires for EVERY role (owner included) until
-- someone explicitly runs ALTER TABLE ... DISABLE TRIGGER.
--
-- NOTE: this rule is not representable in prisma/schema.prisma, so `prisma db push`
-- never created it. It is applied here as raw SQL so it becomes part of the
-- versioned, reproducible migration history (WP-5). Mirrors
-- scripts/apply-audit-append-only-trigger.ts (kept for existing-DB backfill).

CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not allowed (row id=%)', TG_OP, OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_deny_mutation();
